import { useEffect, useRef, useState } from 'react';
import { actionsToCommands, describeProject, parseOffline } from '../../engine';
import type { Settings } from '../../shared/api';
import { api, isDesktop } from '../platform';
import { useEditor } from '../store';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  source?: 'claude' | 'offline';
  error?: boolean;
}

const SUGGESTIONS = [
  'Move the logo to the top right',
  'Change the heading colour to gold',
  'Make the title bigger and add a fade',
  'Make the video black and white',
  'Add text “Limited offer”',
];

export function AiPanel() {
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: 'assistant', text: 'Tell me what to change — for example “move the phone to the right and make the heading blue”. Every change I make can be undone with Ctrl+Z.' },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [msgs]);

  async function send(text: string) {
    const instruction = text.trim();
    if (!instruction || busy) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text: instruction }]);
    setBusy(true);
    const s = useEditor.getState();
    const reply = (msg: Msg) => setMsgs((m) => [...m, msg]);
    try {
      let claudeError: string | undefined;
      if (settings?.hasApiKey) {
        try {
          const res = await api.runAi({ instruction, context: describeProject(s.project, s.selectedId ?? undefined, s.time) });
          const cmds = actionsToCommands(useEditor.getState().project, res.actions, s.time);
          if (cmds.length && !useEditor.getState().dispatch(cmds)) {
            reply({ role: 'assistant', text: 'I could not apply that edit.', source: 'claude', error: true });
          } else {
            reply({ role: 'assistant', text: res.reply, source: 'claude' });
          }
          return;
        } catch (e) {
          claudeError = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        }
      }
      const local = parseOffline(s.project, instruction, s.selectedId ?? undefined, s.time);
      if (local && s.dispatch(local.commands)) {
        reply({ role: 'assistant', text: local.reply + (claudeError ? ` (Claude unavailable: ${claudeError})` : ''), source: 'offline' });
      } else {
        reply({
          role: 'assistant',
          error: true,
          text: claudeError
            ? `Claude request failed: ${claudeError}`
            : settings?.hasApiKey === false && isDesktop
              ? 'I didn’t understand that offline. Add a Claude API key below for full natural-language editing.'
              : 'I didn’t understand that. Try something like “move the logo to the right” or select a layer and say “make it bigger”.',
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    try {
      setSettings(await api.setApiKey(keyDraft));
      setKeyDraft('');
      setShowKey(false);
    } catch (e) {
      useEditor.getState().toast((e as Error).message, 'error');
    }
  }

  return (
    <div className="panel ai-panel">
      <h3>AI assistant</h3>
      <div className="ai-log" ref={logRef}>
        {msgs.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role} ${m.error ? 'error' : ''}`}>
            {m.text}
            {m.source && <span className="ai-source">{m.source === 'claude' ? 'Claude' : 'offline'}</span>}
          </div>
        ))}
        {busy && <div className="ai-msg assistant thinking">Working on it…</div>}
      </div>
      <div className="ai-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>{s}</button>
        ))}
      </div>
      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <textarea
          value={input}
          placeholder="Describe an edit…"
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
        />
        <button className="primary" disabled={busy || !input.trim()}>Send</button>
      </form>
      {isDesktop && settings && (
        <div className="ai-settings">
          <span className={`dot ${settings.hasApiKey ? 'ok' : ''}`} />
          {settings.hasApiKey ? `Claude connected (${settings.model})` : 'Offline mode — basic commands only'}
          <button className="link" onClick={() => setShowKey(!showKey)}>{settings.hasApiKey ? 'Change key' : 'Add API key'}</button>
          {showKey && (
            <div className="key-form">
              <input type="password" placeholder="sk-ant-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
              <button onClick={saveKey}>{keyDraft ? 'Save' : 'Remove key'}</button>
              <p className="hint">Stored encrypted on this computer. Get a key at console.anthropic.com.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
