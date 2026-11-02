export async function readJobStream(stream, onProgress) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;

  const consume = (line) => {
    if (!line.trim()) return null;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { status: "error", message: "Invalid response from the local server. Check the pipeline before retrying." };
    }
    if (event?.type === "error") {
      return { status: "error", message: typeof event.msg === "string" && event.msg ? event.msg : "Error" };
    }
    if (event?.type === "done") {
      return {
        status: "done",
        ...(typeof event.tokens === "number" ? { tokens: event.tokens } : {}),
        ...(typeof event.costUsd === "number" ? { costUsd: event.costUsd } : {}),
      };
    }
    if (event?.type === "text" && typeof event.text === "string") onProgress(event);
    else if (event?.type === "tool" && typeof event.name === "string") onProgress(event);
    else if (event?.type === "status" && typeof event.label === "string") onProgress(event);
    return null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      ended = done;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const completion = consume(line);
        if (completion) return completion;
      }
      if (done) {
        return consume(buffer) ?? {
          status: "error",
          message: "Connection ended before the server confirmed completion. Check the pipeline before retrying.",
        };
      }
    }
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error && error.name === "AbortError" ? "Interrupted. Check the pipeline before retrying." : "Connection error",
    };
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
