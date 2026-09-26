#include <OneWire.h>
#include <FastLED.h>

// --- Pin Definitions ---
const int rfidPins[4] = {53, 51, 49, 47};
const int RELAY_PIN_52 = 52; // Relay Option A
const int RELAY_PIN_44 = 44; // Relay Option B
const int IR_SENSOR_PIN = 32; // HW-201 Digital Output Pin

// --- LED Configuration (Multi-Pin Array) ---
const uint8_t LED_PINS[] = {27, 26};
const uint8_t NUM_STRIPS = sizeof(LED_PINS) / sizeof(LED_PINS[0]);

#define NUM_LEDS    7      // WS2811 node count PER STRIP
#define LED_TYPE    WS2811
#define COLOR_ORDER BRG    // Using BRG order

CRGB leds[NUM_STRIPS][NUM_LEDS];

// Relays are usually Active LOW (LOW = Relay Energized / Unlocked)
#define RELAY_ACTIVE LOW
#define RELAY_INACTIVE HIGH

// HW-201 Active State (Most modules output LOW when obstacle detected)
#define IR_TRIGGERED LOW

OneWire ds[4] = {
  OneWire(rfidPins[0]),
  OneWire(rfidPins[1]),
  OneWire(rfidPins[2]),
  OneWire(rfidPins[3])
};

// --- STATE MACHINE DEFINITION ---
// SHUTDOWN and RESET are new: they replace "just boot into idle" with two
// explicit states the Pi can put the Mega into and get out of on purpose.
enum SystemState {
  STATE_SHUTDOWN,   // Fully off. No sensor polling. Waits for POWER_ON.
  STATE_RESET,      // Primed: dim lights, all maglocks OPEN (unlocked for staff reset), sensors NOT polled. Waits for START.
  STATE_PREPARE,    // Precursor to starting: guests are in, doors locked, lights dimmed further, no puzzles active yet. Waits for START.
  STATE_WAIT_IR,    // Game running: waiting for IR trip. RFID ignored until then.
  STATE_SCANNING,   // IR tripped: RFID scanning active.
  STATE_OPTION_A,   // Latched: Option A solved, relay 52 unlocked.
  STATE_OPTION_B    // Latched: Option B solved, relay 44 unlocked.
};

SystemState currentState = STATE_SHUTDOWN;

struct TargetTag {
  uint8_t facilityCode;
  uint16_t cardId;
};

const TargetTag targetTags[4] = {
  {114, 53509}, // Reader 0 (Pin 53)
  {110, 47207}, // Reader 1 (Pin 51)
  {107, 45945}, // Reader 2 (Pin 49)
  {114, 43602}  // Reader 3 (Pin 47)
};

unsigned long previousMillis = 0;
const unsigned long INTERVAL = 1000;

bool rfidPresent[4] = {false, false, false, false};
bool tagAccepted[4] = {false, false, false, false};
byte rfidIDs[4][8];

void setLEDColorWithReset(CRGB color, uint8_t targetBrightness) {
  for (uint8_t s = 0; s < NUM_STRIPS; s++) fill_solid(leds[s], NUM_LEDS, CRGB::Black);
  FastLED.setBrightness(0);
  FastLED.show();
  delay(50); // Settle pause for line impedance

  for (uint8_t s = 0; s < NUM_STRIPS; s++) fill_solid(leds[s], NUM_LEDS, color);
  FastLED.setBrightness(targetBrightness);
  FastLED.show();
}

void lockAllMaglocks() {
  digitalWrite(RELAY_PIN_52, RELAY_INACTIVE);
  digitalWrite(RELAY_PIN_44, RELAY_INACTIVE);
}

void unlockAllMaglocks() {
  digitalWrite(RELAY_PIN_52, RELAY_ACTIVE);
  digitalWrite(RELAY_PIN_44, RELAY_ACTIVE);
}

void resetRFIDData() {
  for (int i = 0; i < 4; i++) {
    rfidPresent[i] = false;
    tagAccepted[i] = false;
    memset(rfidIDs[i], 0, 8);
  }
}

const char* stateName(SystemState s) {
  switch (s) {
    case STATE_SHUTDOWN: return "SHUTDOWN";
    case STATE_RESET:    return "RESET";
    case STATE_PREPARE:  return "PREPARE";
    case STATE_WAIT_IR:  return "WAIT_IR";
    case STATE_SCANNING: return "SCANNING";
    case STATE_OPTION_A: return "OPTION_A";
    case STATE_OPTION_B: return "OPTION_B";
  }
  return "UNKNOWN";
}

// Position of a stage in the fixed puzzle sequence. SHUTDOWN/RESET sit
// before everything (-1) since nothing has been solved yet. OPTION_A/B
// share a rank because they're alternate endings of the same RFID puzzle,
// not two sequential stages.
int stageOrder(SystemState s) {
  switch (s) {
    case STATE_WAIT_IR:  return 0;
    case STATE_SCANNING: return 1;
    case STATE_OPTION_A: return 2;
    case STATE_OPTION_B: return 2;
    default:              return -1;
  }
}

// FORCE/THROUGH may only jump to the current stage or one ahead of it -
// once a stage is behind the room, only RESET can get back to it.
bool stageIsForceable(SystemState target) {
  return stageOrder(target) >= stageOrder(currentState);
}

// Machine-parseable status line. The Pi's serial reader looks for this
// exact "STATE:" prefix to know what the room is currently doing.
void reportState() {
  Serial.print("STATE:");
  Serial.println(stateName(currentState));
}

void enterState(SystemState newState) {
  currentState = newState;

  switch (currentState) {
    case STATE_SHUTDOWN:
      lockAllMaglocks();
      setLEDColorWithReset(CRGB::Black, 0);
      resetRFIDData();
      Serial.println("[STATE] SHUTDOWN - power off, awaiting POWER_ON.");
      break;

    case STATE_RESET:
      unlockAllMaglocks();
      setLEDColorWithReset(CRGB::White, 30);
      resetRFIDData();
      Serial.println("[STATE] RESET - primed, all maglocks unlocked, sensors idle. Awaiting START.");
      break;

    case STATE_PREPARE:
      lockAllMaglocks();
      setLEDColorWithReset(CRGB::White, 10); // noticeably dimmer than RESET's 30
      resetRFIDData();
      // TODO: once audio hardware exists, kick off ambiance/music here.
      Serial.println("[STATE] PREPARE - dimmed, maglocks locked, no puzzles active. Awaiting START.");
      break;

    case STATE_WAIT_IR:
      lockAllMaglocks();
      setLEDColorWithReset(CRGB::White, 30);
      resetRFIDData();
      Serial.println("[STATE] WAIT_IR - game running, waiting for IR trip.");
      break;

    case STATE_SCANNING:
      setLEDColorWithReset(CRGB::White, 200);
      Serial.println("[STATE] SCANNING - RFID tags active.");
      break;

    case STATE_OPTION_A:
      digitalWrite(RELAY_PIN_52, RELAY_ACTIVE);
      digitalWrite(RELAY_PIN_44, RELAY_INACTIVE);
      setLEDColorWithReset(CRGB::Blue, 200);
      Serial.println("[STATE] OPTION_A - Pin 52 unlocked.");
      break;

    case STATE_OPTION_B:
      digitalWrite(RELAY_PIN_52, RELAY_INACTIVE);
      digitalWrite(RELAY_PIN_44, RELAY_ACTIVE);
      setLEDColorWithReset(CRGB::Red, 200);
      Serial.println("[STATE] OPTION_B - Pin 44 unlocked.");
      break;
  }

  reportState();
}

void setup() {
  Serial.begin(9600);

  for (uint8_t i = 0; i < NUM_STRIPS; i++) {
    switch (LED_PINS[i]) {
      case 27: FastLED.addLeds<LED_TYPE, 27, COLOR_ORDER>(leds[i], NUM_LEDS).setCorrection(UncorrectedColor); break;
      case 26: FastLED.addLeds<LED_TYPE, 26, COLOR_ORDER>(leds[i], NUM_LEDS).setCorrection(UncorrectedColor); break;
      case 40: FastLED.addLeds<LED_TYPE, 40, COLOR_ORDER>(leds[i], NUM_LEDS).setCorrection(UncorrectedColor); break;
      case 38: FastLED.addLeds<LED_TYPE, 38, COLOR_ORDER>(leds[i], NUM_LEDS).setCorrection(UncorrectedColor); break;
    }
  }

  for (int i = 0; i < 4; i++) pinMode(rfidPins[i], INPUT_PULLUP);
  pinMode(IR_SENSOR_PIN, INPUT_PULLUP);
  pinMode(RELAY_PIN_52, OUTPUT);
  pinMode(RELAY_PIN_44, OUTPUT);
  lockAllMaglocks();

  // Boots straight into SHUTDOWN. The Pi has to explicitly send POWER_ON
  // to bring the room up - nothing runs automatically on power-up anymore.
  enterState(STATE_SHUTDOWN);

  Serial.println("MEGA_BOOT");
}

void loop() {
  checkSerialCommands();

  switch (currentState) {
    case STATE_SHUTDOWN:
    case STATE_RESET:
    case STATE_PREPARE:
      // Deliberately no sensor polling in any of these three.
      break;

    case STATE_WAIT_IR:
      if (digitalRead(IR_SENSOR_PIN) == IR_TRIGGERED) {
        Serial.println("[EVENT] IR Sensor Triggered! Activating RFID System...");
        enterState(STATE_SCANNING);
      }
      break;

    case STATE_SCANNING:
      checkRFIDReaders();
      if (millis() - previousMillis >= INTERVAL) {
        previousMillis = millis();
        printStatus();
      }
      break;

    case STATE_OPTION_A:
      digitalWrite(RELAY_PIN_52, RELAY_ACTIVE);
      digitalWrite(RELAY_PIN_44, RELAY_INACTIVE);
      if (millis() - previousMillis >= INTERVAL) {
        previousMillis = millis();
        Serial.println("[STATUS] >>> OPTION A ACTIVE (Pin 52 Unlocked) - LATCHED <<<");
      }
      break;

    case STATE_OPTION_B:
      digitalWrite(RELAY_PIN_52, RELAY_INACTIVE);
      digitalWrite(RELAY_PIN_44, RELAY_ACTIVE);
      if (millis() - previousMillis >= INTERVAL) {
        previousMillis = millis();
        Serial.println("[STATUS] >>> OPTION B ACTIVE (Pin 44 Unlocked) - LATCHED <<<");
      }
      break;
  }

  delay(50); // Bus stability delay
}

void evaluateTagTriggers() {
  bool optionA_Triggered = tagAccepted[0] && tagAccepted[1];
  bool optionB_Triggered = tagAccepted[2] && tagAccepted[3];

  if (optionA_Triggered) {
    enterState(STATE_OPTION_A);
  } else if (optionB_Triggered) {
    enterState(STATE_OPTION_B);
  }
}

void checkRFIDReaders() {
  for (int i = 0; i < 4; i++) {
    byte addr[8];
    ds[i].reset_search();

    if (ds[i].search(addr)) {
      if (addr[0] != 0x00) {
        rfidPresent[i] = true;
        memcpy(rfidIDs[i], addr, 8);

        uint8_t currentFacilityCode = addr[3];
        uint16_t currentCardId = (addr[2] << 8) | addr[1];

        tagAccepted[i] = (currentFacilityCode == targetTags[i].facilityCode &&
                          currentCardId == targetTags[i].cardId);
      } else {
        rfidPresent[i] = false;
        tagAccepted[i] = false;
      }
    } else {
      rfidPresent[i] = false;
      tagAccepted[i] = false;
    }
  }

  evaluateTagTriggers();
}

// --- FORCE-THROUGH HELPERS ---
// These simulate the real trigger condition for a stage (IR beam broken,
// correct tags scanned) instead of jumping straight into a state, so the
// normal transition logic decides what happens next - same as if the
// hardware event had actually occurred.
void forceIRTrip() {
  Serial.println("[EVENT] IR Sensor Triggered! (FORCED) Activating RFID System...");
  enterState(STATE_SCANNING);
}

void forceRFIDAccept() {
  for (int i = 0; i < 4; i++) {
    rfidPresent[i] = true;
    tagAccepted[i] = true;
    rfidIDs[i][3] = targetTags[i].facilityCode;
    rfidIDs[i][1] = (uint8_t)(targetTags[i].cardId & 0xFF);
    rfidIDs[i][2] = (uint8_t)((targetTags[i].cardId >> 8) & 0xFF);
  }
  Serial.println("[EVENT] RFID tags accepted (FORCED)...");
  evaluateTagTriggers();
}

// --- RAW HARDWARE CONTROL (Commands page) ---
// Pokes relays/LEDs directly and reads sensors on demand, without going
// through enterState() - so none of this touches currentState or the
// puzzle logic. Meant for a technician checking wiring, not gameplay.
// Note: while latched in OPTION_A/OPTION_B, loop() re-asserts both relay
// pins every ~50ms to match the latch, so a raw lock command will only
// hold there briefly before the state machine overwrites it again.
void rawSetLock(int relayPin, bool unlock) {
  digitalWrite(relayPin, unlock ? RELAY_ACTIVE : RELAY_INACTIVE);
  Serial.print("[RAW] Lock ");
  Serial.print(relayPin);
  Serial.println(unlock ? " -> UNLOCKED" : " -> LOCKED");
}

void rawSetLed(const String& hexColor, uint8_t brightness) {
  long colorVal = strtol(hexColor.c_str(), NULL, 16);
  uint8_t r = (colorVal >> 16) & 0xFF;
  uint8_t g = (colorVal >> 8) & 0xFF;
  uint8_t b = colorVal & 0xFF;

  for (uint8_t s = 0; s < NUM_STRIPS; s++) fill_solid(leds[s], NUM_LEDS, CRGB(r, g, b));
  FastLED.setBrightness(brightness);
  FastLED.show();

  Serial.print("[RAW] LED -> #");
  Serial.print(hexColor);
  Serial.print(" @ ");
  Serial.println(brightness);
}

void rawLedOff() {
  for (uint8_t s = 0; s < NUM_STRIPS; s++) fill_solid(leds[s], NUM_LEDS, CRGB::Black);
  FastLED.setBrightness(0);
  FastLED.show();
  Serial.println("[RAW] LED -> OFF");
}

// One-shot sensor snapshot, independent of currentState. Reads into local
// variables only - never touches rfidPresent/tagAccepted - so it can't
// interfere with an in-progress SCANNING puzzle.
void reportRawSensors() {
  Serial.print("SENSORS:IR=");
  Serial.print(digitalRead(IR_SENSOR_PIN) == IR_TRIGGERED ? "TRIP" : "CLEAR");

  Serial.print(";LOCK52=");
  Serial.print(digitalRead(RELAY_PIN_52) == RELAY_ACTIVE ? "UNLOCKED" : "LOCKED");
  Serial.print(";LOCK44=");
  Serial.print(digitalRead(RELAY_PIN_44) == RELAY_ACTIVE ? "UNLOCKED" : "LOCKED");

  for (int i = 0; i < 4; i++) {
    byte addr[8];
    ds[i].reset_search();

    Serial.print(";P");
    Serial.print(rfidPins[i]);
    Serial.print("=");

    if (ds[i].search(addr) && addr[0] != 0x00) {
      uint8_t facilityCode = addr[3];
      uint16_t cardId = (addr[2] << 8) | addr[1];
      bool match = (facilityCode == targetTags[i].facilityCode && cardId == targetTags[i].cardId);
      Serial.print(facilityCode);
      Serial.print(",");
      Serial.print(cardId);
      Serial.print(match ? ",MATCH" : ",MISMATCH");
    } else {
      Serial.print("EMPTY");
    }
  }
  Serial.println();
}

void printStatus() {
  Serial.print("[STATUS] ");
  for (int i = 0; i < 4; i++) {
    Serial.print("P");
    Serial.print(rfidPins[i]);
    Serial.print(": ");

    if (rfidPresent[i]) {
      uint8_t facilityCode = rfidIDs[i][3];
      uint16_t cardId = (rfidIDs[i][2] << 8) | rfidIDs[i][1];

      if (facilityCode < 100) Serial.print("0");
      if (facilityCode < 10)  Serial.print("0");
      Serial.print(facilityCode);
      Serial.print(",");

      if (cardId < 10000) Serial.print("0");
      if (cardId < 1000)  Serial.print("0");
      if (cardId < 100)   Serial.print("0");
      if (cardId < 10)    Serial.print("0");
      Serial.print(cardId);

      Serial.print(tagAccepted[i] ? " [ACCEPTED] | " : " [REJECTED] | ");
    } else {
      Serial.print("EMPTY             | ");
    }
  }
  Serial.println();
}

// --- SERIAL COMMAND PROTOCOL (Pi -> Mega) ---
// POWER_ON        turn on, primes into RESET, confirms the Mega is alive
// RESET           re-prime: lock everything, stop polling, wait for START
// RELOAD          just re-lock all maglocks, no state change
// PREPARE         precursor to START: lock doors, dim lights further, no puzzles active
// START           begin the game (waits for IR trip, same as original flow)
// SHUTDOWN        lights off, locked, no polling
// STATUS          ask for a STATE: line right now
// FORCE:WAIT_IR     jump straight to waiting-for-IR
// FORCE:SCANNING    jump straight to RFID scanning, skipping the IR trip
// FORCE:OPTION_A    jump straight to Option A solved (skips needing the RFID tags)
// FORCE:OPTION_B    jump straight to Option B solved
// THROUGH:WAIT_IR   simulate the IR beam actually being tripped (WAIT_IR -> SCANNING)
// THROUGH:SCANNING  simulate all four RFID tags being correctly scanned (SCANNING -> OPTION_A/B)
// (FORCE/THROUGH only ever move forward - a stage already passed rejects
//  both until a RESET puts the room back before it.)
// RAW:LOCK:52:UNLOCK / RAW:LOCK:52:LOCK   poke relay 52 directly, no state change
// RAW:LOCK:44:UNLOCK / RAW:LOCK:44:LOCK   poke relay 44 directly, no state change
// RAW:LED:<RRGGBB>:<brightness>           set the LED strips to an arbitrary color/brightness
// RAW:LED:OFF                             LEDs off, no state change
// SENSORS                                 one-shot IR/RFID/relay snapshot ("SENSORS:..." reply)
void checkSerialCommands() {
  if (Serial.available() <= 0) return;
  String command = Serial.readStringUntil('\n');
  command.trim();
  command.toUpperCase();

  if (command.length() == 0) {
    return;

  } else if (command == "POWER_ON") {
    Serial.println("MEGA_ONLINE");
    enterState(STATE_RESET);

  } else if (command == "RESET") {
    enterState(STATE_RESET);

  } else if (command == "RELOAD") {
    lockAllMaglocks();
    Serial.println("[CMD] RELOAD - all maglocks locked.");

  } else if (command == "PREPARE") {
    enterState(STATE_PREPARE);

  } else if (command == "START") {
    enterState(STATE_WAIT_IR);

  } else if (command == "SHUTDOWN") {
    enterState(STATE_SHUTDOWN);

  } else if (command == "STATUS") {
    reportState();

  } else if (command == "FORCE:WAIT_IR") {
    if (stageIsForceable(STATE_WAIT_IR)) enterState(STATE_WAIT_IR);
    else Serial.println("[CMD] FORCE:WAIT_IR rejected - already past this stage. RESET to go back.");

  } else if (command == "FORCE:SCANNING") {
    if (stageIsForceable(STATE_SCANNING)) enterState(STATE_SCANNING);
    else Serial.println("[CMD] FORCE:SCANNING rejected - already past this stage. RESET to go back.");

  } else if (command == "FORCE:OPTION_A") {
    if (stageIsForceable(STATE_OPTION_A)) enterState(STATE_OPTION_A);
    else Serial.println("[CMD] FORCE:OPTION_A rejected - already past this stage. RESET to go back.");

  } else if (command == "FORCE:OPTION_B") {
    if (stageIsForceable(STATE_OPTION_B)) enterState(STATE_OPTION_B);
    else Serial.println("[CMD] FORCE:OPTION_B rejected - already past this stage. RESET to go back.");

  } else if (command == "THROUGH:WAIT_IR") {
    if (stageIsForceable(STATE_WAIT_IR)) forceIRTrip();
    else Serial.println("[CMD] THROUGH:WAIT_IR rejected - already past this stage. RESET to go back.");

  } else if (command == "THROUGH:SCANNING") {
    if (stageIsForceable(STATE_SCANNING)) forceRFIDAccept();
    else Serial.println("[CMD] THROUGH:SCANNING rejected - already past this stage. RESET to go back.");

  } else if (command == "RAW:LOCK:52:UNLOCK") {
    rawSetLock(RELAY_PIN_52, true);

  } else if (command == "RAW:LOCK:52:LOCK") {
    rawSetLock(RELAY_PIN_52, false);

  } else if (command == "RAW:LOCK:44:UNLOCK") {
    rawSetLock(RELAY_PIN_44, true);

  } else if (command == "RAW:LOCK:44:LOCK") {
    rawSetLock(RELAY_PIN_44, false);

  } else if (command == "RAW:LED:OFF") {
    rawLedOff();

  } else if (command.startsWith("RAW:LED:")) {
    String rest = command.substring(8); // after "RAW:LED:"
    int sep = rest.indexOf(':');
    if (sep > 0) {
      String hex = rest.substring(0, sep);
      uint8_t brightness = (uint8_t) rest.substring(sep + 1).toInt();
      rawSetLed(hex, brightness);
    } else {
      Serial.println("[CMD] RAW:LED malformed - expected RAW:LED:RRGGBB:brightness");
    }

  } else if (command == "SENSORS") {
    reportRawSensors();

  } else {
    Serial.print("[CMD] Unknown command: ");
    Serial.println(command);
  }
}
