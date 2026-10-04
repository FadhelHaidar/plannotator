import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFirstRunAnnouncementWindow } from './useFirstRunAnnouncementWindow';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

interface Props {
  readonly pending?: boolean;
  readonly eligible?: boolean;
  readonly armed?: boolean;
  readonly windowMs?: number;
}

function Probe({ pending = true, eligible = false, armed = true, windowMs = 10_000 }: Props) {
  const visible = useFirstRunAnnouncementWindow({ pending, eligible, armed, windowMs });
  return <div data-probe={visible ? 'shown' : 'hidden'} />;
}

async function render(props: Props) {
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(<Probe {...props} />));
}

const state = () => document.querySelector('[data-probe]')?.getAttribute('data-probe');
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

describe('useFirstRunAnnouncementWindow', () => {
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('opens when the conditions hold before the reader has done anything', async () => {
    await render({ eligible: false });
    expect(state()).toBe('hidden');
    await render({ eligible: true });
    expect(state()).toBe('shown');
  });

  test.skipIf(!hasDom)('a pointer press or key press first means it waits for a later load', async () => {
    for (const event of [new MouseEvent('pointerdown', { bubbles: true }), new KeyboardEvent('keydown', { key: 'a', bubbles: true })]) {
      await render({ eligible: false });
      await act(async () => { document.body.dispatchEvent(event); });
      await render({ eligible: true });
      expect(state()).toBe('hidden');
      if (root) await act(async () => root?.unmount());
      root = null;
    }
  });

  test.skipIf(!hasDom)('focus into a text field closes the window; focus on a button does not', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    await render({ eligible: false });
    await act(async () => button.focus());
    await render({ eligible: true });
    expect(state()).toBe('shown');
    if (root) await act(async () => root?.unmount());
    root = null;

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    await render({ eligible: false });
    await act(async () => textarea.focus());
    await render({ eligible: true });
    expect(state()).toBe('hidden');
  });

  test.skipIf(!hasDom)('never opens over a field the reader is in', async () => {
    // e.g. a comment composer that took focus before the window could close.
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    await render({ eligible: true });
    expect(state()).toBe('hidden');
  });

  test.skipIf(!hasDom)('conditions that arrive after the window (a slow capabilities answer) miss this load', async () => {
    await render({ eligible: false, windowMs: 20 });
    await wait(60);
    await render({ eligible: true, windowMs: 20 });
    expect(state()).toBe('hidden');
  });

  test.skipIf(!hasDom)('the clock only starts once the initial load is done', async () => {
    await render({ eligible: false, armed: false, windowMs: 20 });
    await wait(60);
    await render({ eligible: true, armed: true, windowMs: 20 });
    expect(state()).toBe('shown');
  });

  test.skipIf(!hasDom)('once open it stays until dismissed, whatever the reader presses', async () => {
    await render({ eligible: true, windowMs: 20 });
    expect(state()).toBe('shown');
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); });
    await wait(60);
    await render({ eligible: false, windowMs: 20 });
    expect(state()).toBe('shown');
    // Dismissal (the cookie written) is what closes it.
    await render({ pending: false, eligible: false, windowMs: 20 });
    expect(state()).toBe('hidden');
  });
});
