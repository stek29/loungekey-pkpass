import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { decodeQrDataUrl } from "../src/loungekey.js";

const qrJpegBase64 =
  "/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAhACEDASIAAhEBAxEB/8QAGQABAQADAQAAAAAAAAAAAAAAAAgFBgcE/8QAJxAAAgICAQQCAQUBAAAAAAAAAwQCBQEGAAcIERITFCEJFSIjMVH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8At7uZ7mZdvBKwhKynPWlrHbV+yu7RpMKYgNV6sY4isk2QkplshY8YhjGMRznOf+cq2L9RhHSdGX2fYNapxo5s4CmWv2eM4mr5ViFgNhQTC4GmTkjZLDiCK+IwlnMjmAPHvzK9989ZGzqEbJphjYW6y7VR14c6zMbkMRrNfXiGwSbGycjylSAQRQ+b2YySMZ4FPGOFV/TpfeHJaOQNfdmI7aIXMa44TWVXmJqOlCVQQqyrPmtxhNlJvCeBAytBvGWslhAeAoCr73LBupgg3oH0N+ZdwurRMPOAVGOVvX1g5NsHQEVcs82YWog+vMmF5hJPA/nHHOV7bO8aHcTtSqCFbr5qVpKyOK3orh5n1OlOviUBAt1qcseY2YZYnH2x/GWP9/yFemkt40EB6m90/YIhNdVbFl+0JHd2TF6xV1F9NhZllRmbDMp0ZJsITEIQyth+U0xepV6g7FltZZ22rsFssU9vnX7KMNdEKsXDXu/eVHcKMLp1KExtr4XpffJ4/wAsNeBYnAeSZC3+OOOBKvevQQ3W41bVntrsKultaW1w5r6WqPbKK2xByqn5YTVDKWBDj8kcMQKucJGBSCTGczxyf+l4L8/SfZ9X6gWtfZssu1SB0KSnUrpuHXOmsNGdPbVAgj/ps6bACYUzjMwiiw8uH68RUr3jdtl53EirUEFa92lJSv1FkFi9nUsR+V6qcCQJcIuRz4lWZjKMh4/BPxnz/mqad2pbxp3THcVEEdPhtLdKzrtGtZWB7JcCpaqkrsTZPNSAi/inyUgZIziTORwxMUck9wmuv0Tb0esvTuv0nTtPQ36qpQ3DVfuOv5FTwnjFcrl9KsSTGZQrLh4MzamL3hBMEJML/WdSB3X9PTbdt3u1utltc7QfWbcJiUzN2RZ4OEvZZkKeLGIzMtyUM8+D3abh4xjMYr/LFqCnk3vsi3zqjfaZsu503S/bdvqf22rk/ctXbCCNUtHBc4inI3yWDMmWGsTm2z6FGuD2hGRi+m69tHax1R6X9aMb5vXUJfY62Wvu0aWrK/hTXxZZS+qJTAwgBmOV044Lkay2PeEfEJ+cyiFa8cccBxxxwHHHHAccccD/2Q==";

it("serves routes inside workerd without exposing assets", async () => {
  const health = await SELF.fetch("https://worker.example/healthz");
  expect(health.status).toBe(200);
  expect(health.headers.get("cache-control")).toContain("no-store");

  const form = await SELF.fetch("https://worker.example/");
  expect(form.status).toBe(200);
  expect(await form.text()).toContain('<form method="post"');
  const logo = await SELF.fetch("https://worker.example/pass-logo.png");
  expect(logo.status).toBe(200);
  expect((await logo.arrayBuffer()).byteLength).toBeGreaterThan(0);

  expect((await SELF.fetch("https://worker.example/icon.png")).status).toBe(
    404,
  );
});

it("decodes LoungeKey-style JPEG QR data inside workerd", async () => {
  expect(await decodeQrDataUrl(`data:image/jpeg;base64,${qrJpegBase64}`)).toBe(
    "fixture-qr-payload",
  );
});
