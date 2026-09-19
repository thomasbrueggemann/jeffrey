import http from 'node:http';
import { appendFileSync } from 'node:fs';

/**
 * A metering proxy in front of the local model server.
 *
 * Both agents are pointed at `http://127.0.0.1:<port>/t/<tag>/v1`, so every request is counted at the
 * one place they share — the model server's own `usage` — rather than trusting each tool's report.
 * Streaming requests get `stream_options.include_usage` forced on, so a client that does not ask for
 * usage is still counted. Completion tokens include a thinking model's hidden reasoning.
 */
export function startProxy({ upstream, port, logFile, inject }) {
  const target = new URL(upstream);

  const server = http.createServer((req, res) => {
    const match = /^\/t\/([^/]+)(\/.*)$/.exec(req.url ?? '');
    if (!match) {
      res.writeHead(404).end('expected /t/<tag>/...');
      return;
    }
    const [, tag, path] = match;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      let streaming = false;
      if (req.method === 'POST' && body.length) {
        try {
          const json = JSON.parse(body.toString('utf8'));
          if (json.stream) {
            streaming = true;
            json.stream_options = { ...json.stream_options, include_usage: true };
          }
          // Applied to both tools alike, e.g. turning a thinking model's thinking off for a whole run.
          if (inject) Object.assign(json, inject);
          body = Buffer.from(JSON.stringify(json));
        } catch {
          // not JSON: forward untouched
        }
      }

      const started = Date.now();
      const headers = { ...req.headers, host: target.host, 'content-length': String(body.length) };
      delete headers['accept-encoding'];
      const upstreamReq = http.request(
        { hostname: target.hostname, port: target.port, path, method: req.method, headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          let text = '';
          upstreamRes.on('data', (chunk) => {
            res.write(chunk);
            text += chunk.toString('utf8');
          });
          upstreamRes.on('end', () => {
            res.end();
            if (!path.endsWith('/chat/completions')) return;
            const record = { tag, at: new Date(started).toISOString(), ms: Date.now() - started, status: upstreamRes.statusCode, ...meter(text, streaming) };
            appendFileSync(logFile, `${JSON.stringify(record)}\n`);
          });
        },
      );
      upstreamReq.on('error', (error) => {
        appendFileSync(logFile, `${JSON.stringify({ tag, at: new Date(started).toISOString(), ms: Date.now() - started, error: error.message })}\n`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      // A client that gives up (timeout, ctrl-c) must not leave the server generating for nobody.
      res.on('close', () => {
        if (!res.writableFinished) upstreamReq.destroy();
      });
      upstreamReq.end(body);
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function meter(text, streaming) {
  let usage;
  let finish;
  const payloads = streaming
    ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
    : [text];
  for (const payload of payloads) {
    if (!payload || payload === '[DONE]') continue;
    try {
      const json = JSON.parse(payload);
      if (json.usage) usage = json.usage;
      const reason = json.choices?.[0]?.finish_reason;
      if (reason) finish = reason;
    } catch {
      // partial or non-JSON line
    }
  }
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    // Prompt tokens the server served from its prefix cache: already processed, so cheaper to bill
    // and near-free in time. Zero when the server does not report it.
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    finish: finish ?? null,
    metered: Boolean(usage),
  };
}
