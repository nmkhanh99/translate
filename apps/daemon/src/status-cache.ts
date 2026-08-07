import type { AppConfig, Volume } from "@cfa-translate/shared";

type ScanVolumes = (config: AppConfig) => Promise<Volume[]>;

/** Stale-while-revalidate cache for the expensive filesystem status scan. */
export function createStatusVolumeCache(
  initial: Volume[],
  scan: ScanVolumes
) {
  let snapshot = initial;
  let active: { promise: Promise<Volume[]>; superseded: boolean } | null = null;
  let queuedConfig: AppConfig | null = null;
  let queuedPromise: Promise<Volume[]> | null = null;

  function start(config: AppConfig): Promise<Volume[]> {
    const token = {
      promise: Promise.resolve(snapshot),
      superseded: false,
    };
    token.promise = scan(config)
      .then((volumes) => {
        if (!token.superseded) snapshot = volumes;
        return snapshot;
      })
      .catch(() => snapshot)
      .finally(() => {
        if (active === token) active = null;
      });
    active = token;
    return token.promise;
  }

  return {
    get(): Volume[] {
      return snapshot;
    },

    refresh(config: AppConfig, afterInflight = false): Promise<Volume[]> {
      if (!active) return start(config);
      if (!afterInflight) return active.promise;

      active.superseded = true;
      queuedConfig = config;
      if (!queuedPromise) {
        queuedPromise = active.promise.then(() => {
          const nextConfig = queuedConfig || config;
          queuedConfig = null;
          queuedPromise = null;
          return start(nextConfig);
        });
      }
      return queuedPromise;
    },
  };
}
