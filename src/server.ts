import { app } from "./app.js";

// const PORT =
//   Number(
//     process.env.PORT ?? 3000,
//   );

const HOST =
  process.env.HOST ??
  "0.0.0.0";

app.listen(
  3000,
  HOST,
  () => {
    console.log(
      `Wiki listening on http://${HOST}:3000`,
    );
  },
);