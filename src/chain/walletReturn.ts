/**
 * Coming back from the wallet.
 * ─────────────────────────────────────────────────────────────
 * Kept apart from session.ts, which pulls in WharfKit and its renderer,
 * so the routers and the verify scripts can ask without loading either.
 */

/**
 * The address a wallet comes back to. Anchor on an iPhone or an iPad
 * (WharfKit's generateReturnUrl, in @wharfkit/protocol-esr) sends the
 * page back to itself with "#" and eight random letters and digits, and
 * waits for that exact address before it reads the signature. Our routers
 * know no such address, and showed the home page instead of the screen
 * that was being signed.
 */
export function isWalletReturn(hash: string): boolean {
  return /^#[A-Za-z0-9]{8}$/.test(hash);
}

/**
 * What the wallet was signing when this page was reloaded, if it was.
 *
 * While it waits for Anchor, WharfKit keeps a note in localStorage with the
 * address it will come back to and the transaction id. A page that loads
 * at that very address was reloaded while the wallet was open, Safari's
 * doing when it needs the memory. The wallet only signs (WharfKit asks it
 * not to broadcast) and the page sends what comes back, so a transaction
 * signed then was never sent.
 */
export function returnedSignature(href = location.href): { transactionId: string; actor: string } | undefined {
  try {
    const note = JSON.parse(localStorage.getItem('wharfkit:anchor-transaction-handoff') ?? 'null') as
      { returnUrl?: unknown; transactionId?: unknown; actor?: unknown } | null;
    if (!note || typeof note.returnUrl !== 'string' || typeof note.transactionId !== 'string') return undefined;
    if (new URL(note.returnUrl, href).href !== new URL(href).href) return undefined;
    return { transactionId: note.transactionId, actor: typeof note.actor === 'string' ? note.actor : '' };
  } catch {
    return undefined;
  }
}
