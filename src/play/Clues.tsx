import { useId, useState } from 'react';
import './Clues.css';

export function Clues({ urls, open, clear, ended, onToggle, onClear }: {
  urls: string[]; open: boolean; clear: boolean; ended: boolean;
  onToggle: () => void; onClear: () => void;
}) {
  const id = useId();
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState('');
  const screenshot = urls.find(url => !failed.includes(url));
  const visible = open || ended;
  const isClear = clear || ended;
  return <section className="screenshot-hint" aria-label="截图提示">
    <div className="screenshot-toolbar">
      {ended ? <span>游戏截图</span> : <button type="button" className="hint-toggle" aria-expanded={visible} aria-controls={id} onClick={onToggle}>{visible ? '收起提示' : '查看提示'}</button>}
      {visible && <span className="screenshot-actions">
        <span>{isClear ? '清晰' : '模糊'}</span>
        {!isClear && <button type="button" className="hint-clear" onClick={onClear}>变清晰</button>}
      </span>}
    </div>
    {visible && <div id={id} className={`screenshot-frame ${isClear ? 'is-clear' : 'is-blurred'}`}>
      {screenshot ? <>
        {loaded !== screenshot && <span className="screenshot-status" role="status">截图加载中…</span>}
        <img src={screenshot} alt={isClear ? '游戏截图' : '模糊的游戏截图'} referrerPolicy="no-referrer"
          onLoad={() => setLoaded(screenshot)} onError={() => setFailed(values => [...values, screenshot])} />
      </> : <div className="screenshot-unavailable" role="status"><p>截图加载失败</p><button type="button" onClick={() => { setFailed([]); setLoaded(''); }}>重试</button></div>}
    </div>}
  </section>;
}
