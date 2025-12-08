export function matchFilter(filter: { value: string }, value: string) {
    let filterValue = filter.value.toLowerCase().trim();
    if (!filterValue) return true;
    value = value.toLowerCase().trim();
    return filterValue.split("|").some(part =>
        part.split("&").every(part => {
            part = part.trim();
            if (part.startsWith("!")) {
                part = part.slice(1).trim();
                return !value.includes(part);
            }
            return value.includes(part);
        })
    );
}