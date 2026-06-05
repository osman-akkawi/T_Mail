const DEFAULT_TMAIL_DOMAIN = "tmail";

export function getTMailDomain(): string {
  const raw = (process.env.TMAIL_EMAIL_DOMAIN ?? DEFAULT_TMAIL_DOMAIN)
    .trim()
    .toLowerCase()
    .replace(/^@/, "");

  return raw || DEFAULT_TMAIL_DOMAIN;
}

export function normalizeTMailAddress(input: string): string {
  let value = input.trim().toLowerCase();
  if (!value) {
    return "";
  }

  if (!value.includes("@") && !value.includes("#")) {
    value = `${value}@${getTMailDomain()}`;
  }

  return value;
}

export function getAddressDomain(address: string): string {
  const atIndex = address.lastIndexOf("@");
  return atIndex === -1 ? "" : address.slice(atIndex + 1).toLowerCase();
}

export function isManagedTMailAddress(address: string): boolean {
  return getAddressDomain(address) === getTMailDomain();
}
