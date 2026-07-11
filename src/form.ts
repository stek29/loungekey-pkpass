export const generationForm = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Generate lounge access pass</title>
    <style>
      body { font: 16px system-ui; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; }
      .pass-logo { display: block; max-width: 160px; max-height: 58px; margin: 0 0 2rem; }
      label { display: block; margin: 1rem 0; }
      input { box-sizing: border-box; width: 100%; padding: 0.6rem; }
      button { padding: 0.65rem 1rem; }
    </style>
  </head>
  <body>
    <main>
      <img class="pass-logo" src="/pass-logo.png" alt="Pass logo">
      <h1>Generate lounge access pass</h1>
      <form method="post" action="/generate">
        <label>Username<input name="username" autocomplete="username" required></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <button type="submit">Generate pass</button>
      </form>
    </main>
  </body>
</html>
`;
