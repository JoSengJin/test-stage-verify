/** 입력 검증 실패. 통신 전에 발생한다. */
export class ValidationError extends Error {
  override name = 'ValidationError';
}

/** 서버가 2xx 이외의 상태를 돌려준 경우. */
export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
