export class TMailError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = "TMailError";
  }
}

export class ValidationError extends TMailError {
  constructor(message: string) {
    super(message, 400);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends TMailError {
  constructor(message = "Unauthorized") {
    super(message, 401);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends TMailError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends TMailError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}

export class TelegramApiError extends TMailError {
  constructor(message: string, statusCode = 502) {
    super(message, statusCode);
    this.name = "TelegramApiError";
  }
}
