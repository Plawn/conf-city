interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** One elapsed query around the whole pipeline: WebGL forbids nested queries. */
export class WebGLPipelineTimer {
  private readonly extension: TimerExtension | null;
  private readonly pending = new Set<WebGLQuery>();
  private active: WebGLQuery | null = null;
  private disposed = false;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  }

  get supported() {
    return this.extension !== null;
  }

  begin() {
    const extension = this.extension;
    if (
      !extension ||
      this.disposed ||
      this.active ||
      this.gl.getQuery(extension.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) !== null
    ) {
      return null;
    }
    const query = this.gl.createQuery();
    if (query) {
      this.gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      this.active = query;
    }
    return query;
  }

  async end(query: WebGLQuery): Promise<number | null> {
    const extension = this.extension!;
    this.gl.endQuery(extension.TIME_ELAPSED_EXT);
    this.active = null;
    this.pending.add(query);
    const deadline = performance.now() + 2000;
    try {
      // Poll availability; never call finish(), reuse an old duration or count a
      // disjoint result as zero. One outstanding sample bounds instrumentation.
      while (!this.disposed && performance.now() < deadline) {
        if (this.gl.getParameter(extension.GPU_DISJOINT_EXT)) {
          return null;
        }
        if (this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) {
          const elapsed = Number(this.gl.getQueryParameter(query, this.gl.QUERY_RESULT)) / 1e6;
          return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
        }
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      return null;
    } finally {
      if (this.pending.delete(query)) {
        this.gl.deleteQuery(query);
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const query of this.pending) {
      this.gl.deleteQuery(query);
    }
    this.pending.clear();
  }
}
