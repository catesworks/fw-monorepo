import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Footer } from './Footer.js';

describe('Footer', () => {
  it('renders the wordmark and exactly one link to the Fleetworks platform', () => {
    const { container } = render(<Footer appName="Chorus" />);

    expect(container.textContent).toContain('Fleetworks');

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('Part of the Fleetworks platform');
    expect(links[0].getAttribute('href')).toBe('https://fleetworks.dev');
  });
});
