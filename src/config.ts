export class Config {
  get port(): number {
    const value = Deno.env.get("PORT");
    if (!value) {
      return 13131; // Default port
    }
    const port = parseInt(value, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error("PORT must be a valid port number (1-65535).");
    }
    return port;
  }

  get publicUrl(): string | undefined {
    return Deno.env.get("PUBLIC_URL");
  }
}
