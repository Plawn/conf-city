/** R3F may configure the same canvas again while the async renderer is initializing. */
export function cachedInitializer<C extends object, R>(initialize: (canvas: C) => Promise<R>) {
  const renderers = new WeakMap<C, Promise<R>>();
  return (canvas: C) => {
    let renderer = renderers.get(canvas);
    if (!renderer) {
      renderer = initialize(canvas).catch((error: unknown) => {
        renderers.delete(canvas);
        throw error;
      });
      renderers.set(canvas, renderer);
    }
    return renderer;
  };
}
