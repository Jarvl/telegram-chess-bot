import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api/client';
import type { ButtonSpec } from '../tg/webapp';
import { useApp } from './context';

export type Resource<T> = {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload(): Promise<void>;
  set(data: T): void;
};

/** Loads once per `key`; `initial` (launch data) skips the first request. */
export function useResource<T>(key: string, load: () => Promise<T>, initial?: T): Resource<T> {
  const [data, setData] = useState<T | null>(initial ?? null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(initial === undefined);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'network', String(caught)));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (initial === undefined) void reload();
  }, [key]);
  return { data, error, loading, reload, set: setData };
}

/**
 * Binds Telegram's MainButton to `spec`; returns true when the client has no such button and the
 * screen must render one in the page instead.
 */
export function useMainButton(spec: ButtonSpec | null): boolean {
  const { tg } = useApp();
  const [inPage, setInPage] = useState(false);
  useEffect(() => {
    const bound = tg.setMainButton(spec);
    setInPage(spec !== null && !bound);
    return () => {
      tg.setMainButton(null);
    };
  }, [tg, spec?.text, spec?.enabled, spec?.progress, spec?.onClick]);
  return inPage;
}
