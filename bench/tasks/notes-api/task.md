Extend the notes API in src/server.js.

1. Add `PATCH /notes/:id`. The body may contain `title` and/or `body`; only the fields present change. Respond 200 with the updated note, or 404 with `{"error": "..."}` when the note does not exist. `updatedAt` is set to the time of the change.
2. Validate input on `POST /notes` and `PATCH /notes/:id`. Respond 400 with `{"error": "<message>"}` when the request body is not valid JSON or not a JSON object, when `title` is not a non-empty string of at most 100 characters (on POST it is required; on PATCH it is only checked when present), when `body` is present but not a string, or when a PATCH body contains neither field.

Keep the existing tests passing and add tests for the new behaviour.
