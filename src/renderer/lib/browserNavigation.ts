/** Page title events must preserve explicit names, including names chosen by AI. */
export function browserNavigationData<T extends { titleAuto?: unknown }>(
  current: T,
  patch: { url?: string; title?: string }
): T {
  const { title, ...navigation } = patch
  return {
    ...current,
    ...navigation,
    ...(title !== undefined && current.titleAuto !== false ? { title } : {})
  }
}
