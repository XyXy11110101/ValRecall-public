import { useEffect, useRef, useState } from 'react';
import type { MobileState } from '../database/mobile-repository';
import { dateInTimeZone } from '../sync/protocol';
import type { nativeRequest } from './bridge';
import { isSubpage, type useMobileNavigation } from './navigation';
import { groupMobileTasks } from './task-presentation';
import { buildWidgetProjection, unavailableWidgetProjection } from './widget-projection';
import { readWidgetNavigation, WidgetPublisher, type WidgetNavigation } from './widget-bridge';

interface Options {
  state: MobileState | null;
  now: Date;
  loadError: string;
  epochChanging: boolean;
  busy: boolean;
  native: typeof nativeRequest;
  navigation: ReturnType<typeof useMobileNavigation>;
  prepareAdd: () => Promise<void>;
  notice: (text: string) => void;
}

export function useMobileWidget(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const { state, now, loadError, epochChanging, native, navigation, busy } = options;
  const day = state?.snapshot ? dateInTimeZone(now, state.snapshot.timeZone) : null;
  const publisher = useRef<WidgetPublisher | null>(null);
  const [target, setTarget] = useState<WidgetNavigation | null>(null);
  const [inputReadyFor, setInputReadyFor] = useState<string | null>(null);
  const [futureTarget, setFutureTarget] = useState<WidgetNavigation | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addAttempt, setAddAttempt] = useState(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  const preparing = useRef<string | null>(null);
  const seen = useRef(new Set<string>());
  const userNavigationRevision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const cancel = () => {
      userNavigationRevision.current++;
      targetRef.current = null;
      setTarget(null);
      setInputReadyFor(null);
      setAddError(null);
    };
    window.addEventListener('valrecall-user-navigation', cancel);
    return () => {
      mounted.current = false;
      window.removeEventListener('valrecall-user-navigation', cancel);
    };
  }, []);
  const ready = state !== null || Boolean(loadError);

  useEffect(() => {
    const writer = new WidgetPublisher(native);
    publisher.current = writer;
    return () => {
      writer.dispose();
      publisher.current = null;
    };
  }, [native]);

  function publish() {
    const current = latest.current;
    if (!current.state && !current.loadError) return;
    const reason = current.loadError
      ? 'read-error'
      : current.epochChanging
        ? 'workspace-changed'
        : null;
    publisher.current?.publish(
      reason
        ? unavailableWidgetProjection(reason, current.now)
        : buildWidgetProjection(current.state, current.now),
    );
  }
  const publishRef = useRef(publish);
  publishRef.current = publish;
  useEffect(() => {
    publishRef.current();
  }, [state, day, loadError, epochChanging, native]);
  useEffect(() => {
    const resume = () => publishRef.current();
    window.addEventListener('valrecall-app-resume', resume);
    return () => window.removeEventListener('valrecall-app-resume', resume);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let running = false;
    let queued = false;
    const consume = async () => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        do {
          queued = false;
          const requestedAtRevision = userNavigationRevision.current;
          try {
            const value = await native('navigation.consume', {});
            if (disposed) return;
            if (requestedAtRevision !== userNavigationRevision.current) continue;
            const next = readWidgetNavigation(value);
            if (next && !seen.current.has(next.id)) {
              seen.current.add(next.id);
              if (seen.current.size > 64) seen.current.delete(seen.current.values().next().value!);
              setAddError(null);
              setTarget(next);
            }
          } catch {
            /* Retry only if another widget event arrived while this request waited. */
          }
        } while (queued && !disposed);
      } finally {
        running = false;
      }
    };
    const wake = () => {
      void consume();
    };
    window.addEventListener('valrecall-navigation-ready', wake);
    wake();
    return () => {
      disposed = true;
      window.removeEventListener('valrecall-navigation-ready', wake);
    };
  }, [native, ready]);

  useEffect(() => {
    if (!target || busy) return;
    const current = latest.current;
    const { page } = current.navigation;
    const canEdit =
      current.state?.snapshot?.version === 2 && !current.loadError && !current.epochChanging;
    if (target.kind === 'add-task') {
      if (preparing.current === target.id && page !== 'add-task') {
        setTarget(null);
        return;
      }
      if (!canEdit) {
        current.navigation.go('settings', 'mobile-connection-heading', 'system');
        current.notice('请先在设置中连接电脑。');
        setTarget(null);
        return;
      }
      if (page !== 'add-task') {
        current.navigation.go(isSubpage(page) ? 'tasks' : 'add-task', undefined, 'system');
        return;
      }
      if (preparing.current === target.id) return;
      preparing.current = target.id;
      void current
        .prepareAdd()
        .catch(() => {
          if (mounted.current && targetRef.current?.id === target.id) setAddError('草稿读取失败。');
          return false;
        })
        .then((result) => {
          if (
            result === false ||
            !mounted.current ||
            targetRef.current?.id !== target.id ||
            latest.current.navigation.page !== 'add-task'
          )
            return;
          setInputReadyFor(target.id);
        });
      return;
    }
    if (page !== 'tasks') {
      current.navigation.go('tasks', undefined, 'system');
      return;
    }
    if (target.kind === 'task') {
      const snapshot = current.state?.snapshot;
      const groups =
        current.state && snapshot
          ? groupMobileTasks(current.state, dateInTimeZone(current.now, snapshot.timeZone))
          : null;
      const found =
        !current.loadError &&
        !current.epochChanging &&
        current.state?.epoch === target.epoch &&
        [...(groups?.open ?? []), ...(groups?.future ?? [])].find(
          (row) => row.task.id === target.taskId && row.date === target.occurrenceDate,
        );
      if (found) {
        setFutureTarget(null);
        current.navigation.go('tasks', 'mobile-task-' + found.task.id, 'system');
      } else if (
        canEdit &&
        current.state &&
        snapshot &&
        current.state.epoch === target.epoch &&
        target.occurrenceDate! > dateInTimeZone(current.now, snapshot.timeZone) &&
        groupMobileTasks(current.state, target.occurrenceDate!).open.some(
          (row) => row.task.id === target.taskId && row.date === target.occurrenceDate,
        )
      )
        setFutureTarget(target);
      else {
        setFutureTarget(null);
        current.notice('这项待办已变化。');
      }
    }
    setTarget(null);
  }, [target, busy, state, loadError, epochChanging, navigation.page, native, addAttempt]);

  // Wait for restored input to render before placing the caret and requesting the IME.
  useEffect(() => {
    if (!inputReadyFor || target?.id !== inputReadyFor || navigation.page !== 'add-task') return;
    const input = document.getElementById('mobile-task-title');
    if (input instanceof HTMLInputElement && !input.matches(':disabled')) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      void native('navigation.inputReady', { id: inputReadyFor }).catch(() => undefined);
    }
    setInputReadyFor(null);
    setTarget(null);
  }, [inputReadyFor, target, navigation.page, native]);

  const futureTask =
    futureTarget &&
    state?.snapshot &&
    !loadError &&
    !epochChanging &&
    state.epoch === futureTarget.epoch &&
    futureTarget.occurrenceDate! > (day ?? '')
      ? (groupMobileTasks(state, futureTarget.occurrenceDate!).open.find(
          (row) => row.task.id === futureTarget.taskId && row.date === futureTarget.occurrenceDate,
        ) ?? null)
      : null;
  useEffect(() => {
    if (futureTask && navigation.page === 'tasks')
      navigation.go('tasks', 'mobile-widget-next-task', 'system');
    // Focus only when a new widget target arrives, not each task-state render.
  }, [futureTarget, navigation.page]);
  return {
    futureTask,
    dismissFuture: () => setFutureTarget(null),
    addError,
    retryAdd: () => {
      preparing.current = null;
      setAddError(null);
      setAddAttempt((value) => value + 1);
    },
  };
}
