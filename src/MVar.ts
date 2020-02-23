/**
 * Adapted from https://hackage.haskell.org/package/base-4.12.0.0/docs/Control-Concurrent-MVar.html
 *
 * @since 0.1.13
 */
import * as O from 'fp-ts/lib/Option'
import * as T from 'fp-ts/lib/Task'
import { pipe } from 'fp-ts/lib/pipeable'
import * as A from 'fp-ts/lib/Array'
import { constVoid } from 'fp-ts/lib/function'

/**
 * @example
 * import * as IO from 'fp-ts/lib/IO'
 * import * as MVar from 'fp-ts-contrib/src/MVar'
 * import * as T from 'fp-ts/lib/Task'
 * import { Do } from 'fp-ts-contrib/src/Do'
 * import { log } from 'fp-ts/lib/Console'
 * import { pipe } from 'fp-ts/lib/pipeable'
 * import { randomRange } from 'fp-ts/lib/Random'
 * import { sequenceT } from 'fp-ts/lib/Apply'
 *
 * interface Response {
 *   status: 200 | 401
 * }
 *
 * type Token = string
 *
 * const issuedTokens: Set<Token> = new Set()
 * const isTokenValid = (token: Token): IO.IO<boolean> => () => issuedTokens.has(token)
 * const addToken = (token: Token): IO.IO<void> => () => issuedTokens.add(token)
 * const wipeTokens: IO.IO<void> = () => issuedTokens.clear()
 *
 * setInterval(
 *   pipe(
 *     wipeTokens,
 *     IO.chain(() => log('Tokens wiped.'))
 *   ),
 *   500
 * )
 *
 * const tokenVar = MVar.newEmptyMVar<Token>()
 *
 * const loginRequest: T.Task<Token> = pipe(
 *   log('Logging in'),
 *   IO.chain(() => randomRange(1, 9999)),
 *   IO.map(n => `token-${Math.floor(n)}`),
 *   IO.chainFirst(token => sequenceT(IO.io)(addToken(token), log(`New token "${token}" issued.`))),
 *   T.fromIO,
 *   T.delay(2)
 * )
 *
 * const login: T.Task<void> = pipe(
 *   loginRequest,
 *   T.chain(newToken => MVar.put(newToken)(tokenVar))
 * )
 *
 * const someRequest = (token: Token): T.Task<Response> =>
 *   pipe(
 *     randomRange(50, 200),
 *     T.fromIO,
 *     T.chain(wait =>
 *       pipe(
 *         T.fromIO(isTokenValid(token)),
 *         T.map(isValid => ({ status: isValid ? (200 as const) : (401 as const) })),
 *         T.delay(wait)
 *       )
 *     )
 *   )
 *
 * const handleLogout: T.Task<void> = pipe(
 *   // Take the token out of the MVar. Other concurrent requests
 *   // have to wait for a new token. This prevents race conditions.
 *   MVar.take(tokenVar),
 *   T.chain(() => loginRequest),
 *   T.chain(newToken => MVar.put(newToken)(tokenVar))
 * )
 *
 * const runRequest = (request: (token: Token) => T.Task<Response>): T.Task<Response> =>
 *   Do(T.task)
 *     .bind('id', T.fromIO(pipe(randomRange(1000, 9999), IO.map(Math.floor))))
 *     .bind('token', MVar.read(tokenVar))
 *     .bindL('response', ({ id, token }) =>
 *       pipe(
 *         T.fromIO(log(`[${id}] Request with token ${token}.`)),
 *         T.chain(() => request(token)),
 *         T.chainFirst(_ => T.fromIO(log(`[${id}] ${_.status}`))),
 *         T.chain(res =>
 *           res.status === 401
 *             ? pipe(
 *                 T.fromIO(log(`[${id}] Session expired`)),
 *                 T.chain(() => handleLogout),
 *                 T.chain(() => runRequest(request))
 *               )
 *             : T.of(res)
 *         )
 *       )
 *     )
 *     .return(({ response }) => response)
 *
 * const halt: IO.IO<void> = () => process.exit(0)
 *
 * pipe(
 *   login,
 *   T.chain(() => runRequest(someRequest)),
 *   T.chain(() => T.delay(5)(runRequest(someRequest))),
 *   T.chain(() => T.delay(25)(runRequest(someRequest))),
 *   T.chain(() => T.delay(200)(runRequest(someRequest))),
 *   T.chain(() => T.delay(1)(runRequest(someRequest))),
 *   T.chain(() => T.delay(1)(runRequest(someRequest))),
 *   T.chain(() => T.delay(250)(runRequest(someRequest))),
 *   T.chain(() => T.delay(1)(runRequest(someRequest))),
 *   T.chain(() => T.fromIO(halt))
 * )()
 *
 * @since 0.1.13
 */
class MVar<T> {
  private takeQ: Array<(a: T) => void>
  private putQ: Array<() => void>
  private readQ: Array<(a: T) => void>

  constructor(private value: O.Option<T>) {
    this.takeQ = []
    this.putQ = []
    this.readQ = []

    this.take = this.take.bind(this)
    this.put = this.put.bind(this)
    this.read = this.read.bind(this)
    this.modify = this.modify.bind(this)
    this.isEmpty = this.isEmpty.bind(this)
  }

  private enqueueTake(job: (a: T) => void): void {
    this.takeQ = A.snoc(this.takeQ, job)
  }

  private enqueuePut(job: () => void): void {
    this.putQ = A.snoc(this.putQ, job)
  }

  private enqueueRead(job: (a: T) => void): void {
    this.readQ = A.snoc(this.readQ, job)
  }

  take: T.Task<T> = () =>
    new Promise(resolve =>
      pipe(
        this.value,
        O.fold(
          () => this.enqueueTake(a => resolve(a)),
          a => {
            this.value = O.none
            pipe(
              A.head(this.putQ),
              O.fold(constVoid, putJob => {
                this.putQ = A.dropLeft(1)(this.putQ)
                putJob()
              })
            )
            resolve(a)
          }
        )
      )
    )

  put(a: T): T.Task<void> {
    return () =>
      new Promise(resolve =>
        pipe(
          this.value,
          O.fold(
            () => {
              this.value = O.some(a)
              pipe(
                A.head(this.takeQ),
                O.fold(constVoid, takeJob => {
                  this.takeQ = A.dropLeft(1)(this.takeQ)
                  takeJob(a)
                })
              )
              pipe(
                A.head(this.readQ),
                O.fold(constVoid, readJob => {
                  this.readQ = A.dropLeft(1)(this.readQ)
                  readJob(a)
                })
              )
              resolve()
            },
            () =>
              this.enqueuePut(() => {
                this.value = O.some(a)
                resolve()
              })
          )
        )
      )
  }

  read: T.Task<T> = () =>
    new Promise(resolve =>
      pipe(
        this.value,
        O.fold(() => this.enqueueRead(resolve), resolve)
      )
    )

  modify(f: (a: T) => T.Task<T>): T.Task<void> {
    return pipe(this.take, T.chain(f), T.chain(this.put))
  }

  isEmpty(): boolean {
    return O.isNone(this.value)
  }
}

/**
 * @since 0.1.13
 */
export function newEmptyMVar<T>(): MVar<T> {
  return new MVar<T>(O.none)
}

/**
 * @since 0.1.13
 */
export function newMVar<T>(a: T): MVar<T> {
  return new MVar(O.some(a))
}

/**
 * @since 0.1.13
 */
export function take<T>(mv: MVar<T>): T.Task<T> {
  return mv.take
}

/**
 * @since 0.1.13
 */
export function put<T>(a: T): (mv: MVar<T>) => T.Task<void> {
  return mv => mv.put(a)
}

/**
 * @since 0.1.13
 */
export function read<T>(mv: MVar<T>): T.Task<T> {
  return mv.read
}

/**
 * @since 0.1.13
 */
export function modify<T>(mv: MVar<T>): (f: (a: T) => T.Task<T>) => T.Task<void> {
  return mv.modify
}

/**
 * @since 0.1.13
 */
export function isEmpty<T>(mv: MVar<T>): boolean {
  return mv.isEmpty()
}
