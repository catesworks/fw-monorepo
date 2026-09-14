import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Logo } from './Logo.js';

describe('Logo', () => {
  it('renders just the wordmark with no separator when appName is omitted', () => {
    const { container } = render(<Logo />);
    expect(container.textContent).toBe('Fleetworks');
  });

  it('appends the app name with a " · " separator and applies accentColor', () => {
    const { container } = render(<Logo appName="Chorus" accentColor="#10A47A" />);
    expect(container.textContent).toBe('Fleetworks · Chorus');

    const appNameSpan = screen.getByText('Chorus');
    expect(appNameSpan.style.color).toBe('rgb(16, 164, 122)');
  });

  it('falls back to inherit for color when accentColor is omitted', () => {
    render(<Logo appName="Chorus" />);

    const appNameSpan = screen.getByText('Chorus');
    expect(appNameSpan.style.color).toBe('inherit');
  });
});
