interface ApiOptions extends RequestInit {
  timeout?: number;
  retries?: number;
}

export async function apiFetch<T>(url: string, options: ApiOptions = {}): Promise<T> {
  const { timeout = 8000, retries = 2, ...fetchOptions } = options;
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}
