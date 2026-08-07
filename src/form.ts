export const generationForm = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Generate lounge access pass</title>
    <style>
      body { font: 16px system-ui; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; }
      .disclaimer { margin: 1.5rem 0; padding: 1rem; border: 1px solid #d1d5db; border-radius: 0.5rem; background: #f9fafb; }
      .disclaimer strong { display: block; margin-bottom: 0.35rem; }
      .disclaimer p { margin: 0; }
      label { display: block; margin: 1rem 0; }
      input { box-sizing: border-box; width: 100%; padding: 0.6rem; }
      button { padding: 0.65rem 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Generate lounge access pass</h1>
      <aside class="disclaimer" aria-label="Important disclaimer">
        <strong>Independent, unofficial project</strong>
        <p>This service is not affiliated with, endorsed by, or sponsored by the third-party service provider or any of its affiliates. Your credentials are submitted to this service and used to sign in to your account with that provider; they are not stored. Only continue if you trust the operator of this deployment.</p>
      </aside>
      <form method="post" action="/generate">
        <label>Username<input name="username" autocomplete="username" required></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <button type="submit">Generate pass</button>
      </form>
    </main>
  </body>
</html>
`;
