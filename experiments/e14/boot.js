/**
 * E14 bootstrap (D1-EXP-05).
 *
 * The controller takes its globals as arguments so the page module has no
 * top-level DOM or network access. This file supplies the real ones. Mounting
 * only renders the context panel and attaches click listeners; no connection
 * is attempted until the operator presses a test button.
 */

import { mountE14Page } from "./page.js";

mountE14Page(document, window);
