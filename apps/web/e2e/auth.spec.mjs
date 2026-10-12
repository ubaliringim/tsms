import { test, expect, signIn, PASSWORD, WRONG_PASSWORD } from './fixtures.mjs';

/**
 * Stage 2.8 browser coverage. A real Chromium, the production Next build, the real API, PostgreSQL and Redis.
 *
 * What this cannot prove: behaviour under real TLS (the `Secure` / `__Host-` production cookie is asserted at the
 * HTTP and unit level, and needs a hosted HTTPS check), other browsers, or assistive-technology output beyond
 * the roles and focus Chromium exposes.
 */

const SESSION_COOKIE = 'tsms_session';

test.describe('sign-in and session', () => {
  test('signs in, shows the shell, and keeps the token out of JavaScript', async ({
    page,
    context,
    accounts,
  }) => {
    const user = await accounts.create({ displayName: 'Ada Synthetic' });
    await page.goto('/');
    await signIn(page, user.email);

    await expect(page.getByText('Signed in as')).toBeVisible();
    await expect(page.getByText('Ada Synthetic')).toBeVisible();
    await expect(page.getByText(user.email)).toBeVisible();

    // The cookie exists and is HttpOnly, so script cannot read it.
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === SESSION_COOKIE);
    expect(session).toBeDefined();
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe('Lax');
    expect(session.path).toBe('/');
    expect(await page.evaluate(() => document.cookie)).not.toContain(SESSION_COOKIE);
    // No token in web storage or the URL.
    const storage = await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    );
    expect(storage).not.toContain(session.value);
    expect(page.url()).not.toContain(session.value);
    expect(new URL(page.url()).search).toBe('');
  });

  test('restores the session after a refresh', async ({ page, accounts }) => {
    const user = await accounts.create({ displayName: 'Grace Synthetic' });
    await page.goto('/');
    await signIn(page, user.email);
    await expect(page.getByText('Grace Synthetic')).toBeVisible();

    await page.reload();
    await expect(page.getByText('Grace Synthetic')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('shows no identity and no form before the session has been checked', async ({
    page,
    accounts,
  }) => {
    const user = await accounts.create({ displayName: 'Hidden Until Checked' });
    await page.goto('/');
    await signIn(page, user.email);
    await expect(page.getByText('Hidden Until Checked')).toBeVisible();

    // Hold the restoration request so the pre-restoration state can be observed for as long as needed.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route('**/api/auth/me', async (route) => {
      await held;
      await route.continue();
    });
    const reload = page.reload();
    await expect(page.getByText('Checking your session')).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('Hidden Until Checked');
    expect(body).not.toContain(user.email);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(page.getByLabel('Password')).toHaveCount(0);
    release();
    await reload;
    await expect(page.getByText('Hidden Until Checked')).toBeVisible();
  });

  test('logs out, revokes the session, and back navigation shows no identity', async ({
    page,
    accounts,
    db,
  }) => {
    const user = await accounts.create({ displayName: 'Logout Synthetic' });
    await page.goto('/');
    await signIn(page, user.email);
    await expect(page.getByText('Logout Synthetic')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByText('You have been signed out.')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByText('Logout Synthetic')).toHaveCount(0);

    const [row] = await db.session.findMany({ where: { userId: user.id } });
    expect(row.revokedAt).not.toBeNull();

    // Navigate away and back: the revoked session must not reappear.
    await page.goto('/api/auth/me');
    await page.goBack();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByText('Logout Synthetic')).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('Email')).toBeVisible();
  });

  test('treats an expired session as signed out after a reload', async ({ page, accounts, db }) => {
    const user = await accounts.create({ displayName: 'Expired Synthetic' });
    await page.goto('/');
    await signIn(page, user.email);
    await expect(page.getByText('Expired Synthetic')).toBeVisible();

    await db.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await page.reload();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByText('Expired Synthetic')).toHaveCount(0);
  });

  test('says the session ended when a re-check finds it revoked', async ({
    page,
    accounts,
    db,
  }) => {
    const user = await accounts.create({ displayName: 'Revoked Synthetic' });
    await page.goto('/');
    await signIn(page, user.email);
    await expect(page.getByText('Revoked Synthetic')).toBeVisible();

    await db.session.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
    // A page restored from the back/forward cache fires `pageshow` with `persisted`.
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    await expect(
      page.getByText('Your session has ended. Sign in again to continue.'),
    ).toBeVisible();
    await expect(page.getByText('Revoked Synthetic')).toHaveCount(0);
  });
});

test.describe('failures', () => {
  test('rejects a wrong password with one generic message', async ({ page, accounts }) => {
    const user = await accounts.create();
    await page.goto('/');
    await signIn(page, user.email, WRONG_PASSWORD);
    const alert = page.getByRole('main').getByRole('alert');
    await expect(alert).toHaveText('The email or password is incorrect.');
    // An unknown address gets exactly the same message.
    await signIn(page, 'nobody-here@example.test', WRONG_PASSWORD);
    await expect(alert).toHaveText('The email or password is incorrect.');
  });

  test('shows the rate-limit message from the real limiter', async ({ page, accounts }) => {
    const user = await accounts.create();
    await page.goto('/');
    const alert = page.getByRole('main').getByRole('alert');
    let limited = false;
    for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
      await signIn(page, user.email, WRONG_PASSWORD);
      await expect(alert).toBeVisible();
      limited = (await alert.innerText()).startsWith('Too many attempts');
    }
    expect(limited).toBe(true);
    await expect(alert).toHaveText('Too many attempts. Wait a little while, then try again.');
  });

  test('keeps a confirmed session through an outage and recovers on retry', async ({
    page,
    accounts,
  }) => {
    const user = await accounts.create({ displayName: 'Outage Synthetic' });
    await page.goto('/');
    await signIn(page, user.email);
    await expect(page.getByText('Outage Synthetic')).toBeVisible();

    // The API cannot be reached while the page restores.
    await page.route('**/api/auth/me', (route) => route.abort('connectionfailed'));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Service unavailable' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'does not mean you were signed out',
    );
    await expect(page.getByLabel('Password')).toHaveCount(0);

    await page.unroute('**/api/auth/me');
    await page.getByRole('button', { name: 'Try again' }).click();
    // The session survived the outage: retrying restores it without signing in again.
    await expect(page.getByText('Outage Synthetic')).toBeVisible();
  });

  test('reports a logout the server did not confirm, and stays signed in', async ({
    page,
    accounts,
    db,
  }) => {
    const user = await accounts.create({ displayName: 'Unconfirmed Synthetic' });
    await page.goto('/');
    await signIn(page, user.email);
    await expect(page.getByText('Unconfirmed Synthetic')).toBeVisible();

    await page.route('**/api/auth/logout', (route) => route.abort('connectionfailed'));
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('could not be confirmed');
    await expect(page.getByText('Unconfirmed Synthetic')).toBeVisible();
    const [row] = await db.session.findMany({ where: { userId: user.id } });
    expect(row.revokedAt).toBeNull();
  });
});

test.describe('keyboard and focus', () => {
  test('operates the whole form by keyboard, with visible focus', async ({ page, accounts }) => {
    const user = await accounts.create({ displayName: 'Keyboard Synthetic' });
    await page.goto('/');
    await expect(page.getByLabel('Email')).toBeVisible();

    const active = () =>
      page.evaluate(
        () => document.activeElement?.getAttribute('name') ?? document.activeElement?.tagName,
      );
    await page.keyboard.press('Tab');
    expect(await active()).toBe('email');
    // Keyboard focus is clearly visible, not suppressed.
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.type(user.email);
    await page.keyboard.press('Tab');
    expect(await active()).toBe('password');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Tab');
    expect(await active()).toBe('BUTTON');
    await page.keyboard.press('Enter');

    await expect(page.getByText('Keyboard Synthetic')).toBeVisible();
    // The shell is reachable and sign-out works from the keyboard.
    await page.getByRole('button', { name: 'Sign out' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Email')).toBeVisible();
  });

  test('announces a failure and returns focus to a cleared password field', async ({
    page,
    accounts,
  }) => {
    const user = await accounts.create();
    await page.goto('/');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(WRONG_PASSWORD);
    await page.keyboard.press('Enter');

    const alert = page.getByRole('main').getByRole('alert');
    await expect(alert).toHaveText('The email or password is incorrect.');
    const password = page.getByLabel('Password');
    await expect(password).toBeFocused();
    await expect(password).toHaveValue('');
    // Both fields point at the error so it is read with them.
    const errorId = await alert.getAttribute('id');
    await expect(password).toHaveAttribute('aria-describedby', errorId);
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-describedby', errorId);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  test('disables submission while a sign-in is in flight', async ({ page, accounts }) => {
    const user = await accounts.create();
    await page.goto('/');
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route('**/api/auth/login', async (route) => {
      await held;
      await route.continue();
    });
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    await expect(page.locator('form')).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(page.getByText('Signed in as')).toBeVisible();
  });
});

test.describe('layout', () => {
  for (const [name, viewport] of [
    ['narrow', { width: 360, height: 740 }],
    ['desktop', { width: 1280, height: 800 }],
  ]) {
    test(`fits the ${name} viewport signed out and signed in`, async ({ page, accounts }) => {
      await page.setViewportSize(viewport);
      const user = await accounts.create({ displayName: 'Layout Synthetic' });
      const fits = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        );

      await page.goto('/');
      await expect(page.getByLabel('Email')).toBeVisible();
      expect(await fits()).toBe(true);
      for (const control of [page.getByLabel('Email'), page.getByLabel('Password')]) {
        const box = await control.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
      const button = await page.getByRole('button', { name: 'Sign in' }).boundingBox();
      expect(button.height).toBeGreaterThanOrEqual(44);

      await signIn(page, user.email);
      await expect(page.getByText('Layout Synthetic')).toBeVisible();
      expect(await fits()).toBe(true);
      const signOut = await page.getByRole('button', { name: 'Sign out' }).boundingBox();
      expect(signOut.x + signOut.width).toBeLessThanOrEqual(viewport.width);
      expect(signOut.height).toBeGreaterThanOrEqual(44);
    });
  }
});

test.describe('response headers and policy', () => {
  test('serves the page with its security headers and no policy violations', async ({
    page,
    accounts,
  }) => {
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        (window.__violations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    const response = await page.goto('/');
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    const csp = response.headers()['content-security-policy'];
    for (const directive of [
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "connect-src 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    // No broad script permission has been added to make the framework work.
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline/);

    // The application still hydrates and works under that policy.
    const user = await accounts.create({ displayName: 'Policy Synthetic' });
    await signIn(page, user.email);
    await expect(page.getByText('Policy Synthetic')).toBeVisible();
    expect(await page.evaluate(() => window.__violations ?? [])).toEqual([]);
  });
});
