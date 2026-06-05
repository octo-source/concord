// Concord error type. Every thrown error in server code is a ConcordError so
// route handlers can map `code` onto the API error envelope.
export class ConcordError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ConcordError";
    this.code = code;
    this.details = details;
  }
}
