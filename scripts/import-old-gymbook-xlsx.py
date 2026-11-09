#!/usr/bin/env python3
"""
Convert the old GymBook Android app's "Member Bills" Excel export into a GymBook backup file.

    python3 scripts/import-old-gymbook-xlsx.py "Member_Bills.xlsx" gymbook-import.json

Then, in the web app: Settings → Backup file → Import backup… → pick the .json.
Importing REPLACES everything already in that browser, so do it on an empty site (or export first).

Only the Python standard library is used (an .xlsx is a zip of XML files).

What the sheet holds (one row per bill):
  Invoice Number | Member Name | Membership ID | Mobile | Payment Date | Plan Name | Plan Start Date |
  Plan End Date | Total Amount | Paid Amount | Pending Amount | Payment Method | Plan Type

How it is mapped:
  - one Member per Membership ID; the old ID becomes the member code (148 → GB-0148); names are
    tidied ("Resma .m.bagade." → "Resma M Bagade"); joining date = first plan start
  - one Plan per plan name, priced at that plan's usual total, 1 month long
  - one Membership + one Invoice per bill, with the bill's own dates and number; one Payment for the
    paid amount (so a pending amount shows up as a balance owed)
  - payment methods: Cash → cash, Online/UPI → upi, Card → card; blank → cash with a note
  - new invoices continue after the highest old bill number; new members after the highest old ID
"""
import datetime as dt
import json
import re
import sys
import uuid
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
T = '{%s}t' % NS['m']
# The gym runs on Asia/Kolkata (+05:30). Bills carry a date only; we record payments at 10:00 that day.
PAY_TIME_UTC = 'T04:30:00.000Z'
METHODS = {'cash': 'cash', 'online': 'upi', 'upi': 'upi', 'card': 'card', 'bank': 'bank'}
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def read_sheet(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        shared = [''.join(t.text or '' for t in si.iter(T)) for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS)]
    rows = []
    for row in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).iter('{%s}row' % NS['m']):
        cells = {}
        for c in row.findall('m:c', NS):
            v, inline = c.find('m:v', NS), c.find('m:is', NS)
            if v is not None:
                val = shared[int(v.text)] if c.get('t') == 's' else v.text
            elif inline is not None:
                val = ''.join(t.text or '' for t in inline.iter(T))
            else:
                val = None
            cells[re.match(r'[A-Z]+', c.get('r')).group(0)] = val
        rows.append(cells)
    cols = sorted(rows[0], key=lambda s: (len(s), s))
    header = [rows[0][c] for c in cols]
    return [dict(zip(header, [(r.get(c) or '').strip() for c in cols])) for r in rows[1:]]


def iso(d):
    return dt.datetime.strptime(d, '%d %b %Y').date().isoformat()


def nice(d):  # "2026-11-08" → "8 Nov 2026", the way the app prints dates
    y, m, day = d.split('-')
    return f'{int(day)} {MONTHS[int(m) - 1]} {y}'


def paise(s):
    return round(float(s or 0) * 100)


def tidy_phone(s):  # "+91 95279 44615" → "9527944615"; "N/A" → ""
    digits = re.sub(r'\D', '', s)
    return digits[2:] if len(digits) == 12 and digits.startswith('91') else digits


def tidy_name(s):
    return re.sub(r'\s+', ' ', s.replace('.', ' ')).strip().title()


def new_id(prefix):
    return f'{prefix}_{uuid.uuid4()}'


def stamp(prefix, when, **fields):
    return {'id': new_id(prefix), 'createdAt': when, 'updatedAt': when, 'rev': 1, **fields}


def convert(bills):
    warnings = []
    bills = [b for b in bills if b.get('Membership ID')]
    seq = lambda b: int(re.match(r'\d+', b['Invoice Number']).group(0))
    bills.sort(key=lambda b: (iso(b['Payment Date']), seq(b)))

    plans = {}
    for (name, total), _count in Counter((b['Plan Name'], paise(b['Total Amount'])) for b in bills).most_common():
        if name not in plans:
            plans[name] = stamp('plan', iso(bills[0]['Payment Date']) + PAY_TIME_UTC, name=name, durationValue=1, durationUnit='months', pricePaise=total, archived=False)

    grouped = defaultdict(list)
    for b in bills:
        grouped[b['Membership ID']].append(b)
    members, by_old_id = [], {}
    for old_id, rows in sorted(grouped.items(), key=lambda kv: int(kv[0])):
        first = min(rows, key=lambda b: iso(b['Plan Start Date']))
        phone = tidy_phone(rows[-1]['Mobile'])
        if phone and not re.fullmatch(r'\d{10}', phone):
            warnings.append(f'member {old_id} ({tidy_name(first["Member Name"])}): mobile "{phone}" is not 10 digits')
        m = stamp('mem', iso(first['Payment Date']) + PAY_TIME_UTC, name=tidy_name(first['Member Name']), phone=phone, joiningDate=iso(first['Plan Start Date']), status='active', memberCode=f'GB-{int(old_id):04d}')
        members.append(m)
        by_old_id[old_id] = m

    memberships, invoices, payments, numbers = [], [], [], Counter()
    for b in bills:
        when = iso(b['Payment Date']) + PAY_TIME_UTC
        member, plan = by_old_id[b['Membership ID']], plans[b['Plan Name']]
        start, end, total, paid = iso(b['Plan Start Date']), iso(b['Plan End Date']), paise(b['Total Amount']), paise(b['Paid Amount'])
        if end < start:
            warnings.append(f'bill {b["Invoice Number"]}: plan ends before it starts; end date set to the start date')
            end = start
        number = b['Invoice Number']
        numbers[number] += 1
        if numbers[number] > 1:
            warnings.append(f'bill number {number} appears more than once; the later one is numbered {number} ({numbers[number]})')
            number = f'{number} ({numbers[number]})'
        inv_id, ms_id = new_id('inv'), new_id('ms')
        invoices.append(stamp('inv', when, id=inv_id, number=number, memberId=member['id'], membershipId=ms_id, issueDate=iso(b['Payment Date']),
                              lines=[{'description': f'{plan["name"]} membership (1 month) · {nice(start)} to {nice(end)}', 'quantity': 1, 'unitPricePaise': total, 'amountPaise': total}],
                              subtotalPaise=total, discountPaise=0, totalPaise=total, status='issued'))
        memberships.append(stamp('ms', when, id=ms_id, memberId=member['id'], planId=plan['id'], planName=plan['name'], durationValue=1, durationUnit='months',
                                 startDate=start, endDate=end, listPricePaise=total, discountPaise=0, pricePaise=total, invoiceId=inv_id))
        if paid > 0:
            method = METHODS.get(b['Payment Method'].lower())
            payments.append(stamp('pay', when, memberId=member['id'], invoiceId=inv_id, amountPaise=paid, method=method or 'cash', receivedAt=when, status='recorded',
                                  **({} if method else {'note': 'Payment method was not recorded in the old app'})))

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    backup = {
        'format': 'gymbook-backup', 'version': 1, 'exportedAt': now,
        'data': {
            'members': members, 'plans': list(plans.values()), 'memberships': memberships, 'invoices': invoices, 'adjustments': [], 'payments': payments,
            'attendance': [], 'trainers': [], 'schedules': [], 'expenses': [], 'followups': [], 'sessions': [], 'equipment': [], 'incidents': [], 'workouts': [],
            'settings': None,
            'activity': [{'id': new_id('act'), 'at': now, 'kind': 'system', 'message': f'Imported {len(members)} members and {len(bills)} bills from the old GymBook app export'}],
            'counters': [{'key': 'member', 'value': max(int(k) for k in by_old_id)}, {'key': 'invoice', 'value': max(seq(b) for b in bills)}],
        },
    }
    pending = sum(paise(b['Pending Amount']) for b in bills)
    summary = f'{len(members)} members, {len(plans)} plans, {len(invoices)} bills, {len(payments)} payments, ₹{pending / 100:,.0f} still pending across {sum(1 for b in bills if paise(b["Pending Amount"]) > 0)} bills'
    return backup, summary, warnings


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    backup, summary, warnings = convert(read_sheet(sys.argv[1]))
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        json.dump(backup, f, ensure_ascii=False)
    print(summary)
    for w in warnings:
        print('warning:', w)
    print('written', sys.argv[2])


if __name__ == '__main__':
    main()
