// Errors that end a run with exit 1 before anything is sent or recorded.

/** A bad flag, environment or repository state. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** The run record could not be written, so the run was not recorded. */
export class RecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecordError';
  }
}

/** Git's own output could not be parsed; nothing is sent and nothing recorded. */
export class GitOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitOutputError';
  }
}
