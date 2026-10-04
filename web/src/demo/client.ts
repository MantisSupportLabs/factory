export const browserDemo = import.meta.env.VITE_BROWSER_DEMO === 'true';
interface DemoEngine {
  request(method: string, path: string, body?: unknown): Promise<Response>;
  exportDemo(): Promise<string>;
  resetDemo(): Promise<void>;
  importDemo(text: string): Promise<void>;
}
let engine: Promise<DemoEngine> | undefined;
export function demoEngine(): Promise<DemoEngine> {
  const url = '/demo/engine.js';
  return engine ??= import(/* @vite-ignore */ url);
}
export async function demoRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return (await demoEngine()).request(method, path, body);
}
