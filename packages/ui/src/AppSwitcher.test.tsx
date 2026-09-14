import { describe, it, expect } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { suiteApps } from '@fleet-works/suite-nav';
import { AppSwitcher } from './AppSwitcher.js';

describe('AppSwitcher', () => {
  it('shows the current app name in the closed-state button', () => {
    render(<AppSwitcher currentId="chorus" />);
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('Chorus');
  });

  it('opens the menu on click and lists every suite app with the correct href and weight', () => {
    render(<AppSwitcher currentId="chorus" />);
    const button = screen.getByRole('button');

    fireEvent.click(button);

    const menu = screen.getByRole('menu');
    const menuItems = within(menu).getAllByRole('menuitem');
    expect(menuItems).toHaveLength(suiteApps.length);

    for (const app of suiteApps) {
      const item = menuItems.find((el) => el.getAttribute('href') === app.url);
      expect(item, `expected a menuitem for ${app.id}`).toBeDefined();
      expect(item!.textContent).toContain(app.name);
      if (app.id === 'chorus') {
        expect(item!.style.fontWeight).toBe('600');
      } else {
        expect(item!.style.fontWeight).toBe('400');
      }
    }
  });
});
