interface LabelerIconProps {
  name: 'download' | 'upload' | 'undo' | 'search' | 'skip' | 'trash' | 'external';
}

const paths = {
  download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
  upload: <><path d="M12 21V9"/><path d="m17 14-5-5-5 5"/><path d="M5 3h14"/></>,
  undo: <><path d="m9 7-5 5 5 5"/><path d="M4 12h10a6 6 0 0 1 6 6"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  skip: <><path d="m5 4 10 8-10 8V4Z"/><path d="M19 5v14"/></>,
  trash: <><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 14h10l1-14"/><path d="M9 7V4h6v3"/></>,
  external: <><path d="M15 3h6v6"/><path d="m10 14 11-11"/><path d="M18 13v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h7"/></>,
};

export function LabelerIcon({ name }: LabelerIconProps) {
  return (
    <svg aria-hidden="true" className="labeler-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}
