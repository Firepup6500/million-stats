# pylint: disable=invalid-name
"imports airtable data exported as csvs into an sqlite3 database"
from datetime import datetime
import sqlite3 as sql
import csv

con = sql.connect("new-database.db")

cur = con.cursor()

# pylint: disable=line-too-long
# Create tables
cur.execute(
    "CREATE TABLE IF NOT EXISTS increase (id INTEGER PRIMARY KEY, date DATETIME UNIQUE NOT NULL, change INTEGER NOT NULL, start INTEGER NOT NULL);"
)
cur.execute(
    "CREATE TABLE IF NOT EXISTS misc (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, number INTEGER NOT NULL, userId TEXT);"
)
cur.execute(
    "CREATE TABLE IF NOT EXISTS leaderboard (id INTEGER PRIMARY KEY, userId TEXT NOT NULL, change INTEGER NOT NULL, date DATETIME NOT NULL, UNIQUE(userId, date));"
)
# Create trigger(s)
cur.execute(
    "CREATE TRIGGER IF NOT EXISTS limit_misc_rows_to_two BEFORE INSERT ON misc WHEN (SELECT COUNT(*) FROM misc) >= 2 BEGIN SELECT RAISE(ABORT, 'The misc table only has two rows at max'); END;"
)
# pylint: enable=line-too-long

with open("increase-table.csv", "r", newline="", encoding="utf-8") as file:
    print("Parsing increase csv")
    reader = csv.reader(file)
    next(reader, None)  # header skip
    for row in reader:
        # print(row)
        date = datetime.strptime(row[0], "%m/%d/%Y %H:%M").date().isoformat()
        recordExists = (
            cur.execute("SELECT * FROM increase WHERE date=?", (date,)).fetchone()
            is not None
        )
        # print(recordExists)
        if recordExists:
            cur.execute(
                "UPDATE increase SET change=?, start=? WHERE date=?",
                (row[1], row[2], date),
            )
        else:
            cur.execute(
                "INSERT INTO increase (date, change, start) VALUES (?, ?, ?)",
                (date, row[1], row[2]),
            )
    print("Comitting")
    con.commit()

with open("misc-table.csv", "r", newline="", encoding="utf-8") as file:
    print("Parsing misc csv")
    reader = csv.reader(file)
    next(reader, None)  # header skip
    for row in reader:
        recordExists = (
            cur.execute("SELECT * FROM misc WHERE name=?", (row[0],)).fetchone()
            is not None
        )
        if recordExists:
            cur.execute(
                "UPDATE misc SET number=?, userId=? WHERE name=?",
                (row[1], row[2], row[0]),
            )
        else:
            cur.execute("INSERT INTO misc (name, number, userId) VALUES (?, ?, ?)", row)
    print("Comitting")
    con.commit()
