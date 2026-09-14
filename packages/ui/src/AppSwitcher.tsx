import { useId, useState } from 'react';
import { suiteApps, type SuiteApp } from '@fleet-works/suite-nav';

export interface AppSwitcherProps {
  /** id of the app currently being viewed, e.g. "chorus". */
  currentId: string;
}

/**
 * Header dropdown listing every app in the suite. Deliberately simple —
 * unstyled-ish, relies on the consuming app's own CSS reset + the shared
 * tokens.css custom properties for color/spacing.
 */
export function AppSwitcher({ currentId }: AppSwitcherProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const current = suiteApps.find((app) => app.id === currentId);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--fw-space-2)',
          padding: 'var(--fw-space-2) var(--fw-space-3)',
          borderRadius: 'var(--fw-radius-sm)',
          border: '1px solid var(--fw-color-border)',
          background: 'var(--fw-color-paper)',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: current?.accentColor ?? 'var(--fw-color-muted)',
          }}
        />
        {current?.name ?? 'Fleetworks'}
      </button>

      {open ? (
        <ul
          id={menuId}
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 'var(--fw-space-1)',
            minWidth: 220,
            listStyle: 'none',
            padding: 'var(--fw-space-1)',
            borderRadius: 'var(--fw-radius-md)',
            border: '1px solid var(--fw-color-border)',
            background: 'var(--fw-color-paper)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: 50,
          }}
        >
          {suiteApps.map((app: SuiteApp) => (
            <li key={app.id} role="none">
              <a
                role="menuitem"
                href={app.url}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: 'var(--fw-space-2) var(--fw-space-3)',
                  borderRadius: 'var(--fw-radius-sm)',
                  textDecoration: 'none',
                  color: 'inherit',
                  fontWeight: app.id === currentId ? 600 : 400,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--fw-space-2)' }}>
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: app.accentColor,
                    }}
                  />
                  {app.name}
                </span>
                <span style={{ fontSize: '0.8em', color: 'var(--fw-color-muted)' }}>
                  {app.description}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
