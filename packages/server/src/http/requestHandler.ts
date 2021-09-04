/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { URLSearchParams } from 'url';
import { assertNotBrowser } from '../assertNotBrowser';
import { BaseRequest, BaseResponse } from '../internals/BaseHandlerOptions';
import { callProcedure } from '../internals/callProcedure';
import { getErrorFromUnknown } from '../internals/errors';
import { transformTRPCResponse } from '../internals/transformTRPCResponse';
import {
  AnyRouter,
  inferRouterContext,
  inferRouterError,
  ProcedureType,
} from '../router';
import { TRPCErrorResponse, TRPCResponse, TRPCResultResponse } from '../rpc';
import { TRPCError } from '../TRPCError';
import { getHTTPStatusCode } from './internals/getHTTPStatusCode';
import { getPostBody } from './internals/getPostBody';
import {
  HTTPHandlerInnerOptions,
  HTTPHandlerOptions,
} from './internals/HTTPHandlerOptions';
import {
  HTTPHeaders,
  HTTPRequest,
  HTTPResponse,
} from './internals/HTTPResponse';

assertNotBrowser();

export type CreateContextFnOptions<TRequest, TResponse> = {
  req: TRequest;
  res: TResponse;
};
export type CreateContextFn<TRouter extends AnyRouter, TRequest, TResponse> = (
  opts: CreateContextFnOptions<TRequest, TResponse>,
) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;

const HTTP_METHOD_PROCEDURE_TYPE_MAP: Record<
  string,
  ProcedureType | undefined
> = {
  GET: 'query',
  POST: 'mutation',
  PATCH: 'subscription',
};

function getRawProcedureInputOrThrow(req: HTTPRequest) {
  try {
    if (req.method === 'GET') {
      if (!req.query.has('input')) {
        return undefined;
      }
      const raw = req.query.get('input');
      return JSON.parse(raw!);
    }
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (originalError) {
    throw new TRPCError({
      code: 'PARSE_ERROR',
      originalError,
    });
  }
}

export async function requestHandlerInner<
  TRouter extends AnyRouter,
  TRequest extends HTTPRequest,
>(opts: HTTPHandlerInnerOptions<TRouter, TRequest>): Promise<HTTPResponse> {
  const { createContext, onError, router, req } = opts;
  const batchingEnabled = opts.batching?.enabled ?? true;
  if (req.method === 'HEAD') {
    // can be used for lambda warmup
    return {
      status: 204,
    };
  }
  const type =
    HTTP_METHOD_PROCEDURE_TYPE_MAP[req.method] ?? ('unknown' as const);
  let ctx: inferRouterContext<TRouter> | undefined = undefined;
  let paths: string[] | undefined = undefined;

  const isBatchCall = req.query.get('batch') === '1';
  type TRouterError = inferRouterError<TRouter>;
  type TRouterResponse = TRPCResponse<unknown, TRouterError>;

  function endResponse(
    untransformedJSON: TRouterResponse | TRouterResponse[],
    errors: TRPCError[],
  ): HTTPResponse {
    let status = getHTTPStatusCode(untransformedJSON);
    const headers: HTTPHeaders = {
      'Content-Type': 'application/json',
    };

    const meta =
      opts.responseMeta?.({
        ctx,
        paths,
        type,
        data: Array.isArray(untransformedJSON)
          ? untransformedJSON
          : [untransformedJSON],
        errors,
      }) ?? {};

    for (const [key, value] of Object.entries(meta.headers ?? {})) {
      headers[key] = value;
    }
    if (meta.status) {
      status = meta.status;
    }

    const transformedJSON = transformTRPCResponse(router, untransformedJSON);

    const body = JSON.stringify(transformedJSON);

    return {
      body,
      status,
      headers,
    };
  }

  try {
    if (isBatchCall && !batchingEnabled) {
      throw new Error(`Batching is not enabled on the server`);
    }
    if (type === 'unknown' || type === 'subscription') {
      throw new TRPCError({
        message: `Unexpected request method ${req.method}`,
        code: 'METHOD_NOT_SUPPORTED',
      });
    }
    const rawInput = getRawProcedureInputOrThrow(req);

    paths = isBatchCall ? opts.path.split(',') : [opts.path];
    ctx = await createContext();

    const deserializeInputValue = (rawValue: unknown) => {
      return typeof rawValue !== 'undefined'
        ? router._def.transformer.input.deserialize(rawValue)
        : rawValue;
    };
    const getInputs = (): Record<number, unknown> => {
      if (!isBatchCall) {
        return {
          0: deserializeInputValue(rawInput),
        };
      }

      if (
        rawInput == null ||
        typeof rawInput !== 'object' ||
        Array.isArray(rawInput)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: '"input" needs to be an object when doing a batch call',
        });
      }
      const input: Record<number, unknown> = {};
      for (const key in rawInput) {
        const k = key as any as number;
        const rawValue = (rawInput as any)[k];

        const value = deserializeInputValue(rawValue);

        input[k] = value;
      }
      return input;
    };
    const inputs = getInputs();
    const rawResults = await Promise.all(
      paths.map(async (path, index) => {
        const input = inputs[index];
        try {
          const output = await callProcedure({
            ctx,
            router,
            path,
            input,
            type,
          });
          return {
            input,
            path,
            data: output,
          };
        } catch (_err) {
          const error = getErrorFromUnknown(_err);

          onError?.({ error, path, input, ctx, type: type, req });
          return {
            input,
            path,
            error,
          };
        }
      }),
    );
    const errors = rawResults.flatMap((obj) => (obj.error ? [obj.error] : []));
    const resultEnvelopes = rawResults.map((obj) => {
      const { path, input } = obj;

      if (obj.error) {
        const json: TRPCErrorResponse<TRouterError> = {
          id: null,
          error: router.getErrorShape({
            error: obj.error,
            type,
            path,
            input,
            ctx,
          }),
        };
        return json;
      } else {
        const json: TRPCResultResponse<unknown> = {
          id: null,
          result: {
            type: 'data',
            data: obj.data,
          },
        };
        return json;
      }
    });

    const result = isBatchCall ? resultEnvelopes : resultEnvelopes[0];
    return endResponse(result, errors);
  } catch (_err) {
    // we get here if
    // - batching is called when it's not enabled
    // - `createContext()` throws
    // - post body is too large
    // - input deserialization fails
    const error = getErrorFromUnknown(_err);

    const json: TRPCErrorResponse<TRouterError> = {
      id: null,
      error: router.getErrorShape({
        error,
        type,
        path: undefined,
        input: undefined,
        ctx,
      }),
    };
    onError?.({
      error,
      path: undefined,
      input: undefined,
      ctx,
      type: type,
      req,
    });
    return endResponse(json, [error]);
  }
}

export async function requestHandler<
  TRouter extends AnyRouter,
  TRequest extends BaseRequest,
  TResponse extends BaseResponse,
>(
  opts: {
    req: TRequest;
    res: TResponse;
    path: string;
  } & HTTPHandlerOptions<TRouter, TRequest, TResponse>,
) {
  const createContext = async function _createContext(): Promise<
    inferRouterContext<TRouter>
  > {
    return await opts.createContext?.(opts);
  };
  const { path, router } = opts;

  const body = await getPostBody(opts);
  const req: HTTPRequest = {
    method: opts.req.method!,
    headers: opts.req.headers,
    query: new URLSearchParams((opts.req.query || opts.req.url) as any),
    body,
  };
  const result = await requestHandlerInner({
    path,
    createContext,
    router,
    req,
  });

  const { res } = opts;
  if ('status' in result && (!res.statusCode || res.statusCode === 200)) {
    res.statusCode = result.status;
  }
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    if (!value) {
      continue;
    }
    res.setHeader(key, value);
  }
  res.end(result.body);
  await opts.teardown?.();
}
