// Node 16 fetch polyfill — must be imported before any module that uses fetch
import fetch, { Headers, Request, Response } from 'node-fetch';

if (!globalThis.fetch) {
  globalThis.fetch   = fetch;
  globalThis.Headers  = Headers;
  globalThis.Request  = Request;
  globalThis.Response = Response;
}
