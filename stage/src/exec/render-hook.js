/** Render and rerender the same real React root, awaiting every effect commit. */
export function createHookRenderer(React, createRoot) {
  const effect = React.useEffect;
  const renderHook = (hook, props) => {
    const box = document.createElement('div'); document.body.appendChild(box);
    let pending, last, disposed = false;
    const root = createRoot(box, { onUncaughtError(error) { pending?.reject(error); } });
    function Component({ props }) {
      last = hook(props);
      effect(() => {
        if (pending) { const completed = pending; pending = null; setTimeout(() => completed.resolve(handle), 0); }
      });
      return null;
    }
    const draw = next => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('React commit 시간 초과')); handle.unmount(); }, 10_000);
      pending = {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); handle.unmount(); },
      };
      root.render(React.createElement(Component, { props: next }));
    });
    const handle = {
      get current() { return last; },
      rerender: draw,
      unmount() { if (!disposed) { disposed = true; root.unmount(); box.remove(); } },
    };
    return draw(props);
  };
  renderHook.react = React.default || React;
  return renderHook;
}
