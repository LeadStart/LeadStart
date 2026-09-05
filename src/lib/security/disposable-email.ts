// Disposable / throwaway email-domain blocking for signup + public forms.
//
// A bundled static blocklist of the common throwaway providers: no runtime
// fetch (privacy + reliability). It doesn't need to be exhaustive to be useful:
// it stops the well-known one-click temp-mail services that abuse public signup
// and contact forms, and it's trivial to extend (add a domain to DISPOSABLE_DOMAINS).
//
// Matching is domain-suffix aware: temp-mail providers spin up many alias
// domains and subdomains (x.mailinator.com, *.guerrillamail.*), so an address is
// blocked when its domain equals a listed domain OR is a subdomain of one.

// Lower-case, registrable domains. Keep alphabetized within groups for sanity.
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  // mailinator + aliases
  "mailinator.com", "mailinator.net", "mailinator2.com", "reallymymail.com",
  "sogetthis.com", "spamherelots.com", "notmailinator.com", "binkmail.com",
  // guerrilla mail
  "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz",
  "guerrillamail.de", "guerrillamailblock.com", "grr.la", "sharklasers.com",
  "spam4.me", "pokemail.net",
  // 10minute / temp-mail family
  "10minutemail.com", "10minutemail.net", "temp-mail.org", "temp-mail.io",
  "tempmail.com", "tempmailo.com", "tempr.email", "tmpmail.org", "tmpmail.net",
  "tmpeml.com", "minuteinbox.com", "1secmail.com", "1secmail.net", "1secmail.org",
  "20minutemail.com", "33mail.com",
  // yopmail
  "yopmail.com", "yopmail.net", "yopmail.fr", "cool.fr.nf", "jetable.fr.nf",
  "nospam.ze.tc", "nomail.xl.cx", "mega.zik.dj", "speed.1s.fr",
  // throwaway / trash / fake inbox providers
  "throwawaymail.com", "trashmail.com", "trashmail.de", "trashmail.net",
  "trash-mail.com", "trashmail.io", "getnada.com", "nada.email", "maildrop.cc",
  "dispostable.com", "fakeinbox.com", "fakemail.net", "mailnesia.com",
  "mailnull.com", "spamgourmet.com", "mytemp.email", "emailondeck.com",
  "mohmal.com", "moakt.com", "tempinbox.com", "tempmailaddress.com",
  "burnermail.io", "email-fake.com", "emailfake.com", "fakemailgenerator.com",
  "harakirimail.com", "incognitomail.org", "mailcatch.com", "mailexpire.com",
  "mailforspam.com", "mailtemp.info", "spambog.com", "spambox.us",
  "spamfree24.org", "tempemail.co", "tempemail.com", "tempomail.fr",
  "throwam.com", "wegwerfmail.de", "wegwerfmail.net", "wegwerfmail.org",
  "einrot.com", "getairmail.com", "gettempmail.com", "inboxbear.com",
  "inboxkitten.com", "kzcccttsoo.com", "linshiyouxiang.net", "luxusmail.org",
  "mailbox52.ga", "maileater.com", "mailimate.com", "mailismagic.com",
  "mailpoof.com", "mailsac.com", "mintemail.com", "mvrht.com",
  "no-spam.ws", "noclickemail.com", "objectmail.com", "one-time.email",
  "onmail.win", "owlymail.com", "put2.net", "rppkn.com", "sofimail.com",
  "spamdecoy.net", "spamherelots.com", "tafmail.com", "tempail.com",
  "tempmailer.com", "tempmailer.de", "tempsky.com", "tmailinator.com",
  "vomoto.com", "vpn.st", "yandex.pw", "youmailr.com", "zetmail.com",
  "cloudtempmail.net", "dropmail.me", "fviip033.com", "guerillamail.com",
  "mailhole.de", "mailto.plus", "fexbox.org", "fexbox.ru", "rteet.com",
  "vddaz.com", "chitthi.in", "byom.de", "smailpro.com", "tempm.com",
]);

/** Extract the lower-cased domain from an email, or null if malformed. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || domain.includes("@") || !domain.includes(".")) return null;
  return domain;
}

/**
 * True when the address belongs to a known disposable provider (exact domain or
 * a subdomain of one). A malformed address returns false: leave shape checks to
 * the caller's regex; this only judges disposability.
 */
export function isDisposableEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  for (const blocked of DISPOSABLE_DOMAINS) {
    if (domain.endsWith("." + blocked)) return true;
  }
  return false;
}
