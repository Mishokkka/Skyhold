function domainEntries(entries = []) {
  return entries.map((entry, index) => {
    if (Array.isArray(entry)) return [String(entry[0] ?? `domain-${index + 1}`), entry[1] ?? {}];
    return [`domain-${index + 1}`, entry ?? {}];
  });
}

export function composeDomainGroup(groupName, entries = []) {
  const merged = {};
  const owners = new Map();
  for (const [domainName, domain] of domainEntries(entries)) {
    for (const key of Object.keys(domain ?? {})) {
      if (owners.has(key)) {
        throw new Error(`FBL Skyhold | Duplicate ${groupName} domain member "${key}" in ${owners.get(key)} and ${domainName}.`);
      }
      owners.set(key, domainName);
      merged[key] = domain[key];
    }
  }
  return merged;
}

export function assignDomainGroup(target, groupName, entries = []) {
  const merged = composeDomainGroup(groupName, entries);
  for (const key of Object.keys(merged)) {
    if (Object.hasOwn(target, key)) {
      throw new Error(`FBL Skyhold | Duplicate ${groupName} target member "${key}" already exists before domain assignment.`);
    }
  }
  return Object.assign(target, merged);
}
