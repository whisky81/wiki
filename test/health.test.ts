import test from "node:test";
import assert from "node:assert/strict";

import type { AddressInfo } from "node:net";

import { app } from "../src/app.js";

test(
  "GET /health returns 200",
  async () => {
    process.env.DB_PATH = "./data/test-wiki.db";
    const server = app.listen(
      0,
      "127.0.0.1",
    );

    await new Promise<void>(
      (resolve) => {
        server.once(
          "listening",
          resolve,
        );
      },
    );

    const address =
      server.address() as AddressInfo;

    const response =
      await fetch(
        `http://127.0.0.1:${address.port}/health`,
      );

    assert.equal(
      response.status,
      200,
    );

    const body =
      await response.json();

    assert.equal(
      body.status,
      "ok",
    );

    await new Promise<void>(
      (resolve, reject) => {
        server.close(
          (error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          },
        );
      },
    );
  },
);