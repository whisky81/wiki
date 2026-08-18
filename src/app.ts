import express from "express";

import {
  checkDatabase,
  createPage,
  getPages,
} from "./db.js";

export const app = express();

app.use(
  express.urlencoded({
    extended: false,
  }),
);

app.use(
  (
    req,
    res,
    next,
  ) => {
    const started =
      Date.now();

    res.on(
      "finish",
      () => {
        console.log(
          `${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`,
        );
      },
    );

    next();
  },
);

app.get('/crash', (req, res) => {
  process.exit(1);
});

app.get(
  "/health",
  (_req, res) => {
    try {
      checkDatabase();
      // res.status(500).json({status: "not ok"});
      res.json({
        status: "ok",
        database: "ok",
      });
    } catch {
      res.status(503).json({
        status: "error",
        database: "unavailable",
      });
    }
  },
);

app.get('/deploy', (_req, res) => {
  res.json({
    success: true,
    message: 'Deployment successful',
  })
});

app.get(
  "/",
  (_req, res) => {
    const pages = getPages();

    const list = pages
      .map(
        (page) => `
          <li>
            <strong>${page.title}</strong>

            <pre>${page.content}</pre>
          </li>
        `,
      )
      .join("");

    res.send(`
      <!doctype html>

      <html>
        <body>

          <h1>Mini Wiki</h1>

          <form
            action="/pages"
            method="post"
          >
            <input
              name="title"
              placeholder="Title"
              required
            >

            <br>

            <textarea
              name="content"
              placeholder="Content"
              required
            ></textarea>

            <br>

            <button type="submit">
              Create
            </button>

          </form>

          <hr>

          <ul>
            ${list}
          </ul>

        </body>
      </html>
    `);
  },
);

app.post(
  "/pages",
  (req, res) => {
    const title =
      String(req.body.title ?? "")
        .trim();

    const content =
      String(req.body.content ?? "")
        .trim();

    if (
      !title ||
      !content
    ) {
      return res
        .status(400)
        .send(
          "title and content are required",
        );
    }

    createPage(
      title,
      content,
    );

    return res.redirect("/");
  },
);