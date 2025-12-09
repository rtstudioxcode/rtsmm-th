const channels = new Map();

export function telegramSubscribe(jobId, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  channels.set(jobId, res);

  req.on("close", () => {
    channels.delete(jobId);
  });
}

export function telegramPush(jobId, payload) {
  const res = channels.get(jobId);
  if (res) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}
