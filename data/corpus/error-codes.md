---
id: error-codes
type: manual
machine: all
title: Alarm and error code taxonomy — thermoformers, traysealers and chamber machines
lang: en
---

## 20-29 Film transport alarms

Alarm 20: film end reached. Alarm 21: film splice detected. Alarm 22: film slip / registration lost. Alarm 23: chain overtension. Alarm 27: trim extraction blocked.

Alarm 22 is the most frequent transport alarm in the field and is overwhelmingly mechanical — chain tension, gripper springs, or a worn advance roller.

## 31-39 Infeed and tray transport alarms

Alarm 31: tray jam at infeed. Alarm 32: tray not detected at seal position. Alarm 35: outfeed accumulation full.

Alarm 31 on traysealers usually traces to a skewed tray from a worn infeed guide rail, not to the transport drive.

## 40-49 Sealing station alarms

Alarm 40: seal pressure not reached. Alarm 41: seal pressure lost during dwell. Alarm 44: seal temperature deviation. Alarm 47: vacuum not reached during sealing cycle. Alarm 49: seal bar wear limit exceeded.

Alarm 47 is the single most reported alarm across the installed base. It is generated whenever the chamber does not reach the vacuum setpoint inside the sealing cycle. In field data the distribution of root causes is roughly: seal bar PTFE cover 35%, chamber gasket 30%, worn pump vanes 20%, vacuum sensor drift 10%, other 5%.

## 50-59 Pneumatic and vacuum supply

Alarm 50: compressed air pressure low. Alarm 52: vacuum pump overtemperature. Alarm 55: filter differential pressure high.

## 60-69 Safety and interlock

Alarm 61: safety door open during cycle. Alarm 63: light curtain interrupted. Alarm 65: emergency stop active.

Safety alarms are never cleared by software override. If an interlock alarm repeats with the door closed, the interlock switch is faulty and the machine must be taken out of service.

## 70-79 Communication and drive faults

Alarm 71: fieldbus timeout. Alarm 74: servo drive not ready. Alarm 77: encoder signal loss.

Alarm 77 typically presents as registration drift that worsens with line speed, and points to a cracked encoder coupling.
