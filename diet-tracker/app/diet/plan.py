"""תוכנית הירידה: קו יעד ליניארי ו-17 שבועות."""
from datetime import date, timedelta

START = date(2026, 11, 18)
END = date(2027, 3, 17)
START_KG = 83.0
END_KG = 75.0
TOTAL_DAYS = (END - START).days  # 119 = 17 שבועות בדיוק
WEEKS = TOTAL_DAYS // 7  # 17


def target_for(d: date) -> float:
    t = min(max((d - START).days, 0), TOTAL_DAYS)
    return round(START_KG + (END_KG - START_KG) * t / TOTAL_DAYS, 2)


def week_rows():
    """שבוע i מסתיים ב-START + 7i; היעד הוא ערך הקו באותו יום."""
    for i in range(1, WEEKS + 1):
        d = START + timedelta(days=7 * i)
        yield i, d.isoformat(), round(target_for(d), 1)


def week_range(i: int):
    """טווח התאריכים (כולל) שממוצעים לשבוע i. שבוע 1 כולל גם את יום ההתחלה."""
    end = START + timedelta(days=7 * i)
    start = end - timedelta(days=7 if i == 1 else 6)
    return start.isoformat(), end.isoformat()


def as_dict():
    return {
        "start": START.isoformat(),
        "end": END.isoformat(),
        "start_kg": START_KG,
        "end_kg": END_KG,
        "protein_min": 130,
        "protein_max": 150,
    }
