/**
 * Dev / Beta mode toggle.
 *
 * Set to `true`  — beta-tester checkbox appears on the registration form,
 *                   and accounts registered with it can access the Accuracy page.
 * Set to `false` — checkbox is hidden; the /api/accuracy-report endpoint returns
 *                   403 for everyone; the Accuracy link never appears in the sidebar.
 *
 * One change here = fully off everywhere (server + client both import this constant).
 */
export const DEV_MODE_ENABLED = true;
