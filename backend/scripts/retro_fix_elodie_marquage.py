#!/usr/bin/env python3
"""
Rétro-fix du marquage d'Elodie F sur Rémi S au R20.
Le code de calcul actuel a mal détecté l'élimination ; on corrige manuellement.
"""
import json
import os
import shutil
from datetime import datetime, timezone

BONUSES_PATH = '/opt/versant-api/backend/data/bonuses.json'
FROZEN_PATH = '/opt/versant-api/backend/data/frozen_results.json'

# Backups
ts = datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copyfile(BONUSES_PATH, BONUSES_PATH + '.bak.' + ts)
shutil.copyfile(FROZEN_PATH, FROZEN_PATH + '.bak.' + ts)

# Vérification : Rémi S a-t-il été éliminé au R20 ?
with open(FROZEN_PATH, 'r', encoding='utf-8') as f:
    frozen = json.load(f)
r20 = frozen['rounds']['20']
remi_eliminated = any(str(e.get('id')) == '84388438' for e in r20.get('eliminations', []))
print(f'Rémi S éliminé au R20 : {remi_eliminated}')

if not remi_eliminated:
    print('❌ Annulé : Rémi pas éliminé au R20')
    exit(1)

# Effect_result attendu
now_iso = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
corrected_effect = {
    'targetId': '84388438',
    'targetName': 'Rémi S',
    'targetEliminated': True,
    'pointsAwarded': 1,
    'calculatedInRound': 20,
    'retroFixApplied': True
}

# Update bonuses.json
with open(BONUSES_PATH, 'r', encoding='utf-8') as f:
    bonuses = json.load(f)

fixed = 0
for b in bonuses:
    if b.get('id') == 'bonus-68391361-1778242333008':
        b['effect_applied'] = True
        b['effect_result'] = corrected_effect
        b['effect_applied_at'] = now_iso
        fixed += 1
        print(f'✅ bonuses.json mis à jour')

with open(BONUSES_PATH + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(bonuses, f, indent=2, ensure_ascii=False)
os.replace(BONUSES_PATH + '.tmp', BONUSES_PATH)

# Update seasonBonuses[3] dans frozen_results.json
fixed_archive = 0
for b in frozen.get('seasonBonuses', {}).get('3', []):
    if b.get('id') == 'bonus-68391361-1778242333008':
        b['effect_applied'] = True
        b['effect_result'] = corrected_effect
        b['effect_applied_at'] = now_iso
        fixed_archive += 1
        print(f'✅ seasonBonuses[3] mis à jour')

# Update bonusesUsed dans r20 si présent
for b in r20.get('bonusesUsed', []):
    if b.get('id') == 'bonus-68391361-1778242333008':
        b['effect_applied'] = True
        b['effect_result'] = corrected_effect
        b['effect_applied_at'] = now_iso
        print(f'✅ rounds[20].bonusesUsed mis à jour')

with open(FROZEN_PATH + '.tmp', 'w', encoding='utf-8') as f:
    json.dump(frozen, f, indent=2, ensure_ascii=False)
os.replace(FROZEN_PATH + '.tmp', FROZEN_PATH)

print(f'\n✅ Fix appliqué ({fixed} bonus + {fixed_archive} archive)')
print(f'Backups : .bak.{ts}')
print('⚠️  Penser à pm2 restart versant-api après ce script')