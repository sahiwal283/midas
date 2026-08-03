"""
Deterministic field-extraction rules for receipt OCR text.

Pure functions used by FieldInferenceEngine (postprocess.py). Tuned against
real production corrections (eval/corrections-eval.json). No heavy deps,
no network calls.

Each extractor returns {'value': ..., 'confidence': float, 'source': 'inference'}.
"""

import re
from datetime import date
from typing import Any, Dict, List, Optional, Tuple


def _result(value: Any, confidence: float) -> Dict[str, Any]:
    return {'value': value, 'confidence': round(confidence, 4), 'source': 'inference'}


def _empty() -> Dict[str, Any]:
    return {'value': None, 'confidence': 0, 'source': 'inference'}


# ---------------------------------------------------------------------------
# Merchant
# ---------------------------------------------------------------------------

# Checked in order against the whole text; first hit wins. Order matters:
# more specific brands/contexts (e.g. Delta Stays hotel bookings) must be
# checked before broader ones (Delta the airline, Hilton, ...).
KNOWN_MERCHANTS: List[Tuple[str, str, float]] = [
    (r'sahara\s+las\s+vegas', 'Sahara Las Vegas', 0.9),
    (r'delta\s+stays|delta\s+itinerary', 'Delta Stays', 0.92),
    (r'\blyft\b', 'Lyft', 0.95),
    (r'\buberx?\b', 'Uber', 0.95),
    (r'skymiles|adelta|delta\s+air|\bdelta\b[\s\S]{0,120}flight\s+receipt', 'Delta', 0.92),
    # "Est. Travel Time" is Southwest's itinerary-email phrasing.
    (r'rapid\s+rewards|southwest|est\.?\s+travel\s+time', 'Southwest Airlines', 0.92),
    # "Carrier Interface Charge" is a Frontier-only fee line.
    (r'frontier|carrier\s+interface\s+charge', 'Frontier Airlines', 0.9),
    (r'american\s+airlines|aadvantage', 'American Airlines', 0.92),
    (r'siegel|bagelmania', "Siegel's Bagelmania", 0.9),
    (r'fontainebleau|fontalnebleau', 'Fontainebleau', 0.9),
    (r'home\s+depot', 'The Home Depot', 0.92),
    (r'edlen|\bedl\s?en\b', 'Edlen Electrical', 0.9),
    (r'shepard\s+exposition|\bshepard\b', 'Shepard Exposition Services', 0.9),
    (r'\bhertz\b', 'Hertz', 0.95),
    (r'\bavis\b', 'Avis', 0.95),
    (r'\bstarbucks\b', 'Starbucks', 0.95),
    (r'\bmcdonalds?\b', 'McDonalds', 0.95),
    (r'\bchipotle\b', 'Chipotle', 0.95),
    (r'\bwalmart\b', 'Walmart', 0.95),
    (r'\bcostco\b', 'Costco', 0.95),
    (r'\bconoco\b', 'Conoco', 0.9),
    (r'ups\s+shipment|\bups\b.{0,40}(?:shipment|tracking)', 'UPS', 0.9),
    (r'\blve\b', 'LVE Expo', 0.85),
    (r'austin\s+bergst', 'Austin Airport', 0.85),  # Austin-Bergstrom Intl (AUS)
    (r'\bhilton\b', 'Hilton', 0.9),
    (r'\bhyatt\b', 'Hyatt', 0.9),
]

RIDESHARE_PATTERNS: List[Tuple[str, str, float]] = [
    (r'your ride to', 'Uber', 0.85),
    (r'trip with uber|uber trip', 'Uber', 0.95),
    (r'trip with lyft|lyft trip|your lyft', 'Lyft', 0.9),
]

# Zelle/P2P payments: the recipient (printed in caps) is the merchant.
_ZELLE_RE = re.compile(r'(?i:zelle\S*\s+payment\s+to)\s+([A-Z]{2,}(?:\s+[A-Z]{2,})*)')
# Hotel folio restaurant charges name the venue as "Outlet: X".
_OUTLET_RE = re.compile(r'outlet\s*:\s*([A-Za-z][A-Za-z &\'.-]{2,40})', re.I)

_ADDRESS_RE = re.compile(
    r'\d{1,6}\s+\S+.*\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|'
    r'way|pkwy|parkway|lane|ln|hwy|highway|suite|ste|ct|court|plaza|cir)\b\.?',
    re.I)
_PHONE_RE = re.compile(r'(\+?1[-. )(]*)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}')
_CITY_STATE_RE = re.compile(r',\s*[A-Z]{2}\b|\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b')
# Street line without a leading number ("Barton Springs Road")
_STREET_SUFFIX_RE = re.compile(
    r'\b(road|rd|street|st|avenue|ave|boulevard|blvd|drive|dr|parkway|pkwy|lane|ln)\b\.?\s*$', re.I)

# Lines that cannot be a business name: document boilerplate, handwritten
# trade-show annotations, dates/times, POS transaction fields, addresses.
_JUNK_LINE_RES = [re.compile(p, re.I) for p in [
    r'^\W+$',
    r'page\s+\d',
    r'^\d',
    r'@|https?:|www\.|\.com\b|[$#%>«»]',
    r'^(de|of|by|for|and)\s',
    r'\d+\s*x\s*\d+',
    r'\d{5}(-\d{4})?\s*$',   # ends with a ZIP
    r'[-\s]\d{4}$',          # handwritten annotations ending in a year
    r'\b(invoices?|receipts?|orders?|ordered|payments?|statements?|summary|'
    r'confirmation|details?|information|info|itinerary|vouchers?|subtotal|total|'
    r'amounts?|balance|due|deposit|billing|bill\s+to|ship\s+(to|from)|remit|memo|'
    r'description|quantity|qty|items?|price|company|customer|contacts?|'
    r'employees?|references?|routing|accounts?|tax|taxes|fees?|payable|'
    r'united\s+states|america)\b',
    r'\b(welcome|thanks?|thank\s+you|hi|hello|dear|customer\s+copy|gratuity)\b',
    r'\b(dates?|time|server|table|check|chk|tbl|guest|gst|cashier|ticket|trans\w*|'
    r'auth\w*|approval|terminal|card|visa|mastercard|amex|american\s+express|'
    r'discover|debit|credit|sale|flight|departs?|arrives?)\b',
    r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}',
    r'\d{1,2}[:/]\d{2}',
    r'[a-z]+-\d+$',
    r'\b(day|dinner|lunch|breakfast|setup|set\s*up|show\s+day|last\s+day|'
    r'per\s+diem)\b',
    r'^shows?\b',
    r'\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b',
]]

# A line right after one of these labels is a person/recipient, not the merchant.
_PERSON_CONTEXT_RE = re.compile(
    r'\b(bill\s*to|billing|customer|contact|payee|renter|sold\s+to|attendee|'
    r'passenger|ship\s+to|name|company\s+info)\b', re.I)


def _is_junk_line(line: str) -> bool:
    if len(line.strip()) < 4:
        return True
    digits = sum(c.isdigit() for c in line)
    if digits > len(line) * 0.4:
        return True
    if _ADDRESS_RE.search(line) or _PHONE_RE.search(line) or _CITY_STATE_RE.search(line):
        return True
    return any(rx.search(line) for rx in _JUNK_LINE_RES)


def _clean_merchant_line(line: str) -> str:
    cleaned = re.sub(r'[*"“”|•·®™_]+', ' ', line)
    cleaned = re.sub(r'\s{2,}', ' ', cleaned).strip(' .,:;-')
    return cleaned


def extract_merchant(lines: List[str], ocr_confidence: float) -> Dict[str, Any]:
    full_text = ' '.join(lines)
    full_lower = full_text.lower()

    for pattern, name, confidence in KNOWN_MERCHANTS:
        if re.search(pattern, full_lower):
            return _result(name, confidence)

    for pattern, name, confidence in RIDESHARE_PATTERNS:
        if re.search(pattern, full_lower):
            return _result(name, confidence)

    zelle = _ZELLE_RE.search(full_text)
    if zelle:
        return _result(zelle.group(1).strip().title(), 0.85)

    for raw in lines:
        outlet = _OUTLET_RE.search(raw)
        if outlet:
            return _result(_clean_merchant_line(outlet.group(1)), 0.8)

    def _addressish(candidate: str, allow_bare_street: bool = True) -> bool:
        if _ADDRESS_RE.search(candidate) or _PHONE_RE.search(candidate):
            return True
        return allow_bare_street and bool(_STREET_SUFFIX_RE.search(candidate))

    best_line, best_score = None, 0
    for idx, raw in enumerate(lines[:25]):
        line = _clean_merchant_line(raw)
        if not line or _is_junk_line(line):
            continue
        if any(_PERSON_CONTEXT_RE.search(prev) for prev in lines[max(idx - 2, 0):idx]):
            continue
        score = 1
        # Receipt headers put the business name directly above its address/phone;
        # the closer the address, the stronger the signal. A numberless street
        # line ("Barton Springs Road") only backs multi-word candidates —
        # single words above it are usually fragments of a split address.
        multi_word = len(line.split()) >= 2
        if idx + 1 < len(lines) and _addressish(lines[idx + 1], allow_bare_street=multi_word):
            score += 5
        elif _addressish(' | '.join(lines[idx + 2:idx + 4]), allow_bare_street=multi_word):
            score += 3
        if idx == 0:
            score += 3
        elif idx < 6:
            score += 2
        if multi_word:
            score += 1
        if line.isupper() or line.istitle():
            score += 1
        if score > best_score:
            best_score, best_line = score, line

    if best_line:
        confidence = min(0.55 + 0.06 * best_score, 0.85) * ocr_confidence
        return _result(best_line, confidence)

    return _empty()


# ---------------------------------------------------------------------------
# Amount
# ---------------------------------------------------------------------------

# Lines whose numbers must never be picked as the transaction total.
_AMOUNT_EXCLUDE_RE = re.compile(
    r'sub[\s.-]*total|\btax(es)?\b|\btip\b|gratuit|change\s+due|cash\b|tender|'
    r'discount|saving|per\s+(passenger|person|night|day)|resort\s+fee|room\s+tax|'
    r'mileage|point|reward|refund|deposit|rate\b', re.I)

_PAID_LABEL_RE = re.compile(
    r'(amount|total)\s+paid|\bpaid\b|payment\s+amount|payments?\s+total|'
    r'total\s+payments?|total\s+charge[ds]?|\bcharged\b|grand\s+total|'
    r'total\s*\(\d+\s*passengers?\)', re.I)

# A bare "payment" only labels a value on its own line (e.g. "Online ACH
# Payment ... $2,519.00"); as a section header it precedes unrelated numbers.
_PAYMENT_SAMELINE_RE = re.compile(r'\bpayments?\b', re.I)

_TOTAL_LABEL_RE = re.compile(
    r'total\s+due|balance\s+due|amount\s+due|order\s+total|total\s+amount|'
    r'invoice\s+total|total\s+dollars|(?<![a-z-])total\b', re.I)

_AMOUNT_LABEL_RE = re.compile(r'\bamount\b', re.I)

# OCR artifact: "$412 00" -> "$412.00" (lost decimal point after a currency amount)
_SPACE_DECIMAL_RE = re.compile(r'([$¤]\s*\d[\d,]*) (\d{2})\b')

_MONEY_RE = re.compile(
    r'(?P<cur>[$¤]\s*|usd\s*)?'
    r'(?<![\d.,/-])'
    r'(?P<num>\d{1,3}(?:\.\d{3})+\.\d{2}'   # OCR European-ish artifact: 4.114.25
    r'|\d{1,3}(?:,\d{3})+(?:\.\d{2})?'
    r'|\d+\.\d{2}'
    r'|\d+)'
    r'(?![\d/-])', re.I)


def _parse_money(line: str) -> List[Tuple[float, bool, bool]]:
    """Return (value, has_currency, has_decimals) tuples found in a line."""
    line = re.sub(r'(?<=\d)[Oo](?=\d)', '0', line)  # OCR 'O'->'0' inside numbers
    line = _SPACE_DECIMAL_RE.sub(r'\1.\2', line)
    out = []
    for m in _MONEY_RE.finditer(line):
        num = m.group('num')
        has_cur = bool(m.group('cur'))
        multi_dot = num.count('.') > 1
        has_dec = bool(re.search(r'\.\d{2}$', num))
        if multi_dot:
            whole, _, cents = num.rpartition('.')
            num = whole.replace('.', '') + '.' + cents
        value_str = num.replace(',', '')
        if len(value_str.replace('.', '')) > 8:
            continue  # transaction/tracking id, not money
        try:
            value = float(value_str)
        except ValueError:
            continue
        out.append((value, has_cur, has_dec or multi_dot))
    return out


_MONEY_ONLY_LINE_RE = re.compile(r'^[\s$¤()\-—,.\d]+$')


def _labeled_value(lines: List[str], idx: int) -> Optional[float]:
    """Money for a label at lines[idx]: same line, else nearby lines (after, then before)."""
    def usable(candidates):
        vals = [v for v, cur, dec in candidates if (cur or dec) and 0.01 <= v <= 100000]
        return max(vals) if vals else None

    same = usable(_parse_money(lines[idx]))
    if same is not None:
        return same
    for j in range(idx + 1, min(idx + 4, len(lines))):
        if _AMOUNT_EXCLUDE_RE.search(lines[j]):
            continue
        found = usable(_parse_money(lines[j]))
        if found is not None:
            # Columnar OCR often emits the whole value column after the label
            # block; the total is the largest value in that run of money-only
            # lines, not the first one.
            if _MONEY_ONLY_LINE_RE.match(lines[j]):
                run = [found]
                k = j + 1
                while k < min(j + 10, len(lines)) and _MONEY_ONLY_LINE_RE.match(lines[k]):
                    run_val = usable(_parse_money(lines[k]))
                    if run_val is not None:
                        run.append(run_val)
                    k += 1
                return max(run)
            return found
    for j in range(idx - 1, max(idx - 3, -1), -1):
        if _AMOUNT_EXCLUDE_RE.search(lines[j]):
            continue
        found = usable(_parse_money(lines[j]))
        if found is not None:
            return found
    return None


def extract_amount(text: str, ocr_confidence: float) -> Dict[str, Any]:
    lines = [ln.strip() for ln in text.split('\n') if ln.strip()]

    tiers: Dict[str, List[float]] = {'paid': [], 'total': [], 'amount': []}
    plain_currency: List[float] = []
    plain_decimal: List[float] = []

    for idx, line in enumerate(lines):
        excluded = bool(_AMOUNT_EXCLUDE_RE.search(line))
        if not excluded:
            tier = None
            if _PAID_LABEL_RE.search(line):
                tier = 'paid'
            elif _TOTAL_LABEL_RE.search(line):
                tier = 'total'
            elif _PAYMENT_SAMELINE_RE.search(line):
                same_line = [v for v, cur, dec in _parse_money(line)
                             if (cur or dec) and 0.01 <= v <= 100000]
                if same_line:
                    tiers['paid'].append(max(same_line))
                continue
            elif _AMOUNT_LABEL_RE.search(line):
                tier = 'amount'
            if tier:
                value = _labeled_value(lines, idx)
                if value:
                    tiers[tier].append(value)
                continue
        for value, has_cur, has_dec in _parse_money(line):
            if not (0.01 <= value <= 100000) or excluded:
                continue
            if has_cur and has_dec:
                plain_currency.append(value)
            elif has_dec:
                plain_decimal.append(value)

    # Highest-priority label wins; among equal labels the largest value wins,
    # because grand totals >= partial totals (e.g. per-passenger, pre-tip).
    for tier, conf in (('paid', 0.95), ('total', 0.92), ('amount', 0.8)):
        if tiers[tier]:
            return _result(max(tiers[tier]), min(conf * ocr_confidence, 0.98))

    if plain_currency:
        return _result(max(plain_currency), min(0.7 * ocr_confidence, 0.75))
    if plain_decimal:
        return _result(max(plain_decimal), min(0.5 * ocr_confidence, 0.6))
    return _empty()


# ---------------------------------------------------------------------------
# Date
# ---------------------------------------------------------------------------

_MONTHS = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}
_MONTH_RE = (r'(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|'
             r'jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|'
             r'dec(?:ember)?)')

# (regex, group order) -> (month, day, year)
# Components must not cross line breaks ([ \t] rather than \s) and the day may
# not be the tail of a longer number ((?<!\d)) — otherwise "…28203\nMar 16, 2026"
# parses as "03 Mar 16" → 2016-03-03.
_DATE_FORMATS: List[Tuple[re.Pattern, Tuple[int, int, int]]] = [
    # Range "Mar 30 - Apr 2, 2026": the start date is the transaction-relevant one.
    (re.compile(_MONTH_RE + r'\.?[ \t]*(\d{1,2})[ \t]*[-–—][ \t]*(?:' + _MONTH_RE.replace('(', '(?:', 1)
                + r'\.?[ \t]*)?\d{1,2},?[ \t]+(\d{4})', re.I), (1, 2, 3)),
    # Month DD, YYYY / Mar 16, 2026 / Jan19'26
    (re.compile(_MONTH_RE + r"\.?[ \t]*(\d{1,2})(?:st|nd|rd|th)?[,' \t]+(\d{2,4})", re.I), (1, 2, 3)),
    # DD Month YYYY / 03 Mar 2025 / 01-Apr-2026 / 20 Jan'26
    (re.compile(r"(?<!\d)(\d{1,2})[ \t.-]*" + _MONTH_RE + r"[ \t.,'-]*(\d{2,4})", re.I), (2, 1, 3)),
]
# Leading/trailing '-' allowed so ranges like 3/16/2026-3/19/2026 parse from the start.
_NUMERIC_DATE_RE = re.compile(r'(?<![\d/.])(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?![\d/])')
_ISO_DATE_RE = re.compile(r'(?<![\d/.])(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)')

_DATE_LABEL_TIER_A = re.compile(
    r'date\s+of\s+purchase|purchase\s+date|payment\s+date|invoice\s+date|'
    r'transaction\s+date|issue\s+date|order(?:ed)?\s+on|booking\s+date|charged\s+on', re.I)
_DATE_LABEL_TIER_B = re.compile(r'departure|check[\s-]?out', re.I)
# Bare "Date:" at line start, but not "Due Date"/"Event Dates"/arrival/expiry.
_DATE_LABEL_TIER_C = re.compile(r'^\W*dates?\b', re.I)
_DATE_LABEL_NEG = re.compile(r'\b(due|event|arrival|expir\w*|start|end)\b.{0,12}date|dates?\s+(of\s+)?(birth)', re.I)


def _valid_iso(year: int, month: int, day: int) -> Optional[str]:
    if year < 100:
        year += 2000
    # Plausibility window for receipt dates: rejects OCR junk like "0000-614".
    if not (2015 <= year <= 2035):
        return None
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def _month_name_dates(text: str) -> List[str]:
    out = []
    for rx, (mi, di, yi) in _DATE_FORMATS:
        for m in rx.finditer(text):
            month = _MONTHS.get(m.group(mi)[:3].lower())
            if not month:
                continue
            iso = _valid_iso(int(m.group(yi)), month, int(m.group(di)))
            if iso:
                out.append((m.start(), iso))
    return [iso for _, iso in sorted(out)]


def _numeric_dates(text: str) -> List[str]:
    out = []
    for m in _ISO_DATE_RE.finditer(text):
        iso = _valid_iso(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if iso:
            out.append((m.start(), iso))
    for m in _NUMERIC_DATE_RE.finditer(text):
        iso = _valid_iso(int(m.group(3)), int(m.group(1)), int(m.group(2)))
        if iso:
            out.append((m.start(), iso))
    return [iso for _, iso in sorted(out)]


def _dates_in(text: str) -> List[str]:
    return _month_name_dates(text) + _numeric_dates(text)


def _labeled_date(lines: List[str], idx: int, label_rx: re.Pattern) -> Optional[str]:
    m = label_rx.search(lines[idx])
    after = lines[idx][m.end():]
    found = _dates_in(after)
    if found:
        return found[0]
    for j in range(idx + 1, min(idx + 4, len(lines))):
        found = _dates_in(lines[j])
        if found:
            return found[0]
    return None


def extract_date(text: str, ocr_confidence: float) -> Dict[str, Any]:
    lines = [ln.strip() for ln in text.split('\n') if ln.strip()]

    for label_rx, conf in ((_DATE_LABEL_TIER_A, 0.95),
                           (_DATE_LABEL_TIER_B, 0.9),
                           (_DATE_LABEL_TIER_C, 0.85)):
        for idx, line in enumerate(lines):
            if _DATE_LABEL_NEG.search(line):
                continue
            # A lone "Date" cell in a scrambled table column is not a usable
            # label; require a value ("Date: x") or a real header row.
            if label_rx is _DATE_LABEL_TIER_C and ':' not in line and len(line.split()) < 4:
                continue
            if label_rx.search(line):
                iso = _labeled_date(lines, idx, label_rx)
                if iso:
                    return _result(iso, min(conf * ocr_confidence, 0.98))

    # Unlabeled: month-name dates are almost always the transaction date,
    # numeric ones are often itinerary/line-item dates.
    named = _month_name_dates(text)
    if named:
        return _result(named[0], min(0.85 * ocr_confidence, 0.95))
    numeric = _numeric_dates(text)
    if numeric:
        return _result(numeric[0], min(0.75 * ocr_confidence, 0.9))
    return _empty()


# ---------------------------------------------------------------------------
# Category
# ---------------------------------------------------------------------------

# keyword -> weight; score = sum(weight * min(occurrences, 3)).
WEIGHTED_CATEGORY_KEYWORDS: Dict[str, Dict[str, int]] = {
    'Booth / Marketing / Tools': {
        'booth': 3, 'exhibitor': 3, 'exhibition': 2, 'expo': 2, 'trade show': 3,
        'tradeshow': 3, 'convention center': 2, 'event facility': 3,
        'sponsorship': 2, 'signage': 2, 'banner': 2, 'display': 1,
        'marketing': 2, 'decorator': 2, 'sq ft': 2, 'sqft': 2, 'electrical': 2,
        'brochure': 1, 'flyer': 1,
    },
    'Travel - Flight': {
        'airline': 3, 'airlines': 3, 'airways': 1, 'airfare': 3, 'flight': 2,
        'airport': 2, 'boarding': 2, 'skymiles': 3, 'rapid rewards': 3,
        'itinerary': 2, 'base fare': 2, 'segment tax': 2, 'passenger': 1,
        'aviation': 1,
    },
    'Accommodation - Hotel': {
        'hotel': 3, 'resort fee': 3, 'room tax': 3, 'room number': 2, 'room no': 2,
        'folio': 3, 'nightly': 3, 'lodging': 2, 'accommodation': 2,
        'marriott': 2, 'hilton': 2, 'hyatt': 2, 'motel': 2, 'inn': 1,
        'resort': 1, 'suites': 1, 'check-in': 1, 'checkout': 1,
    },
    'Transportation - Uber / Lyft / Others': {
        'uber': 3, 'lyft': 3, 'taxi': 2, 'rideshare': 3, 'ride-share': 3,
        'trip with': 2, 'your ride': 2, 'pickup': 1, 'drop-off': 2,
        'dropoff': 2, 'driver': 1, 'fare': 1, 'cab': 1,
    },
    'Parking Fees': {
        'parking': 3, 'parked': 2, 'valet': 2, 'garage': 1, 'prk': 2, 'meter': 1,
    },
    'Rental - Car / U-haul': {
        'rental agreement': 3, 'rental': 2, 'hertz': 3, 'avis': 3,
        'u-haul': 3, 'uhaul': 3, 'rent a car': 3, 'car hire': 2,
        'vehicle rental': 3, 'enterprise': 1,
    },
    'Meal and Entertainment': {
        'restaurant': 2, 'cafe': 2, 'coffee': 1, 'diner': 2, 'bistro': 2,
        'grill': 2, 'kitchen': 1, 'bar': 1, 'pub': 2, 'food': 1, 'dining': 2,
        'breakfast': 2, 'lunch': 2, 'dinner': 2, 'meal': 2, 'entertainment': 2,
        'bagel': 2, 'deli': 2, 'bakery': 2, 'espresso': 1, 'sandwich': 2,
        'catering': 2, 'starbucks': 2, 'server': 2, 'table': 1, 'guest': 1,
        'guests': 1, 'dessert': 2, 'hookah': 2, 'sushi': 2, 'taco': 2,
        'pizza': 2, 'burger': 2, 'steakhouse': 2, 'lounge': 1, 'grocery': 2,
        'brewery': 2, 'entree': 2, 'appetizer': 2, 'margarita': 2,
    },
    'Gas / Fuel': {
        'gas': 2, 'fuel': 2, 'gasoline': 3, 'unleaded': 3, 'diesel': 3,
        'petrol': 3, 'shell': 2, 'exxon': 3, 'chevron': 3, 'mobil': 2,
        'gallon': 2, 'pump': 2,
    },
    'Show Allowances - Per Diem': {
        'per diem': 3, 'per-diem': 3, 'allowance': 2, 'daily allowance': 3,
    },
    'Model': {
        'model': 2, 'talent': 2, 'appearance': 1,
    },
    'Shipping Charges': {
        'shipping': 2, 'freight': 3, 'shipment': 3, 'fedex': 3, 'usps': 3,
        'dhl': 3, 'courier': 2, 'tracking': 2, 'waybill': 3, 'ups': 2,
    },
}

_MAX_KEYWORD_OCCURRENCES = 3


def _keyword_occurrences(text_lower: str, keyword: str) -> int:
    kw = keyword.strip().lower()
    if not kw:
        return 0
    if ' ' in kw or '-' in kw:
        return text_lower.count(kw)
    return len(re.findall(rf'(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])', text_lower))


def predict_category(text_lower: str, ocr_confidence: float) -> Dict[str, Any]:
    best_category, best_score = None, 0
    for category, keywords in WEIGHTED_CATEGORY_KEYWORDS.items():
        score = sum(
            weight * min(_keyword_occurrences(text_lower, kw), _MAX_KEYWORD_OCCURRENCES)
            for kw, weight in keywords.items()
        )
        if score > best_score:
            best_score, best_category = score, category

    if best_category:
        confidence = min((0.5 + min(best_score, 12) * 0.035) * ocr_confidence, 0.95)
        return _result(best_category, confidence)
    return _empty()
