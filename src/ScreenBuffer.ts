import * as events from "events";
import {Char, attributesFlyweight, defaultAttributes} from "./Char";
import * as i from "./Interfaces";
import * as e from "./Enums";
import {List} from "immutable";
import {error, times} from "./utils/Common";

interface SavedState {
    cursorRow: number;
    cursorColumn: number;
    attributes: i.Attributes;
}

export class ScreenBuffer extends events.EventEmitter {
    public static hugeOutputThreshold = 300;
    public cursorRow = 0;
    public cursorColumn = 0;
    public _showCursor = true;
    public _blinkCursor = true;
    public activeScreenBufferType = e.ScreenBufferType.Standard;
    private storage = List<List<Char>>();
    private _attributes: i.Attributes = {...defaultAttributes, color: e.Color.White, weight: e.Weight.Normal};
    private isOriginModeSet = false;
    private isCursorKeysModeSet = false;
    private _margins: Margins = {top: 0, left: 0};
    private savedState: SavedState | undefined;

    constructor() {
        super();
    }

    writeMany(value: string): void {
        for (let i = 0; i !== value.length; ++i) {
            this.writeOne(value.charAt(i));
        }
    }

    writeOne(char: string): void {
        const charObject = Char.flyweight(char, this.attributes);

        if (charObject.isSpecial()) {
            switch (charObject.keyCode) {
                case e.KeyCode.Bell:
                    break;
                case e.KeyCode.Backspace:
                    this.moveCursorRelative({horizontal: -1});
                    break;
                case e.KeyCode.Tab:
                    this.moveCursorAbsolute({column: Math.floor((this.cursorColumn + 8) / 8) * 8});
                    break;
                case e.KeyCode.NewLine:
                    if (this.cursorRow === this._margins.bottom) {
                        this.scrollUp(1);
                    } else {
                        this.moveCursorRelative({vertical: 1});
                    }

                    break;
                case e.KeyCode.CarriageReturn:
                    this.moveCursorAbsolute({column: 0});
                    break;
                default:
                    error(`Couldn't write a special char "${charObject}" with char code ${charObject.toString().charCodeAt(0)}.`);
            }
        } else {
            this.set(charObject);
            this.moveCursorRelative({horizontal: 1});
        }
        this.emitData();
    }

    scrollDown(count: number) {
        this.storage = this.storage.splice((this._margins.bottom || 0) - count + 1, count).toList();
        times(count, () => this.storage = this.storage.splice(this.cursorRow, 0, undefined).toList());
    }

    scrollUp(count: number, deletedLine = this._margins.top) {
        times(count, () => this.storage = this.storage.splice((this._margins.bottom || 0) + 1, 0, undefined).toList());
        this.storage = this.storage.splice(deletedLine, count).toList();
    }

    get attributes(): i.Attributes {
        return this._attributes;
    }

    resetAttributes(): void {
        this._attributes = defaultAttributes;
    }

    setAttributes(attributes: i.Attributes): void {
        this._attributes = attributesFlyweight({...this._attributes, ...attributes});
    }

    toRenderable(status: e.Status, fromStorage = this.storage): List<List<Char>> {
        let storage = fromStorage;

        if (status === e.Status.InProgress && (this._showCursor || this._blinkCursor)) {
            const cursorRow = this.cursorRow - (this.storage.size - fromStorage.size);
            const cursorColumn = this.cursorColumn;

            const cursorCoordinates = [cursorRow, cursorColumn];

            if (!storage.get(cursorRow)) {
                storage = storage.set(cursorRow, List<Char>(Array(cursorColumn).fill(Char.empty)));
            }


            if (!storage.getIn(cursorCoordinates)) {
                storage = storage.setIn(cursorCoordinates, Char.empty);
            }

            let char: Char = storage.getIn(cursorCoordinates);
            storage = storage.setIn(
                cursorCoordinates,
                Char.flyweight(char.toString(), {...char.attributes, cursor: true}),
            );
        }

        return storage;
    }

    toCutRenderable(status: e.Status): List<List<Char>> {
        return this.toRenderable(status, <List<List<Char>>>(this.storage.takeLast(ScreenBuffer.hugeOutputThreshold)));
    }

    toLines(): string[] {
        return this.storage.map(row => {
            if (row) {
                return row.map(char => {
                    if (char) {
                        return char.toString();
                    } else {
                        return " ";
                    }
                }).join("");
            } else {
                return "";
            }
        }).toArray();
    }

    toString(): string {
        return this.toLines().join("\n");
    }

    showCursor(state: boolean): void {
        this.ensureRowExists(this.cursorRow);
        this._showCursor = state;
        this.emitData();
    }

    blinkCursor(state: boolean): void {
        this.ensureRowExists(this.cursorRow);
        this._blinkCursor = state;
        this.emitData();
    }

    moveCursorRelative(advancement: Advancement): this {
        const row = Math.max(0, this.cursorRow + (advancement.vertical || 0));
        const column = Math.max(0, this.cursorColumn + (advancement.horizontal || 0));

        this.moveCursorAbsolute({ row: row, column: column });

        this.ensureRowExists(this.cursorRow);
        this.emitData();

        return this;
    }

    moveCursorAbsolute(position: Partial<RowColumn>): this {
        if (typeof position.column === "number") {
            this.cursorColumn = Math.max(position.column, 0) + this.homePosition.column;
        }

        if (typeof position.row === "number") {
            this.cursorRow = Math.max(position.row, 0) + this.homePosition.row;
        }

        this.ensureRowExists(this.cursorRow);
        this.emitData();

        return this;
    }

    deleteRight(n: number) {
        if (this.storage.get(this.cursorRow)) {
            this.storage = this.storage.update(
                this.cursorRow,
                List<Char>(),
                (row: List<Char>) => row.splice(this.cursorColumn, n).toList(),
            );
        }
        this.emitData();
    }

    insertSpaceRight(n: number) {
        if (this.storage.get(this.cursorRow)) {
            let nSpace = "";
            for (let i = 0; i < n; i++) { nSpace += " "; }
            this.storage = this.storage.update(
                this.cursorRow,
                List<Char>(),
                (row: List<Char>) => row.splice(this.cursorColumn, 0, nSpace).toList(),
            );
        }
        this.emitData();
    }

    eraseRight(n: number) {
        if (this.storage.get(this.cursorRow)) {
            this.storage = this.storage.update(
                this.cursorRow,
                List<Char>(),
                (row: List<Char>) => row.take(this.cursorColumn)
                    .concat(Array(n).fill(Char.empty), row.skip(this.cursorColumn + n))
                    .toList(),
            );
        }
        this.emitData();
    }

    clearRow() {
        this.storage = this.storage.set(this.cursorRow, List<Char>());
        this.emitData();
    }

    clearRowToEnd() {
        if (this.storage.get(this.cursorRow)) {
            this.storage = this.storage.update(
                this.cursorRow,
                List<Char>(),
                (row: List<Char>) => row.take(this.cursorColumn).toList(),
            );
        }
        this.emitData();
    }

    clearRowToBeginning() {
        if (this.storage.get(this.cursorRow)) {
            const replacement = Array(this.cursorColumn).fill(Char.empty);
            this.storage = this.storage.update(
                this.cursorRow,
                row => row.splice(0, this.cursorColumn + 1, ...replacement).toList());
        }
        this.emitData();
    }

    clear() {
        this.storage = List<List<Char>>();
        this.moveCursorAbsolute({row: 0, column: 0});
    }

    clearToBeginning() {
        this.clearRowToBeginning();
        const replacement = Array(this.cursorRow);

        this.storage = this.storage.splice(0, this.cursorRow, ...replacement).toList();
        this.emitData();
    }

    clearToEnd() {
        this.clearRowToEnd();
        this.storage = this.storage.splice(this.cursorRow + 1, this.storage.size - this.cursorRow).toList();
        this.emitData();
    }

    get size(): number {
        return this.storage.size;
    }

    isEmpty(): boolean {
        return this.storage.size === 0;
    }

    set originMode(mode: boolean) {
        this.isOriginModeSet = mode;
    }

    set cursorKeysMode(mode: boolean) {
        this.isCursorKeysModeSet = mode;
    }

    get cursorKeysMode(): boolean {
        return this.isCursorKeysModeSet;
    }

    set margins(margins: Partial<Margins>) {
        this._margins = {...this._margins, ...margins};
    }

    get marginTop(): number {
        return this._margins.top;
    }

    at(position: RowColumn): Char {
        return this.storage.getIn([position.row, position.column]);
    }

    saveCurrentState() {
        this.savedState = {
            cursorRow: this.cursorRow,
            cursorColumn: this.cursorColumn,
            attributes: {...this.attributes},
        };
    }

    restoreCurrentState() {
        if (this.savedState) {
            this.moveCursorAbsolute({row: this.savedState.cursorRow, column: this.savedState.cursorColumn});
            this.setAttributes(this.savedState.attributes);
        } else {
            console.error("No state to restore.");
        }
    }

    private get homePosition(): RowColumn {
        if (this.isOriginModeSet) {
            return {row: this._margins.top || 0, column: this._margins.left || 0};
        } else {
            return {row: 0, column: 0};
        }
    }

    private set(char: Char): void {
        this.ensureRowExists(this.cursorRow);
        this.storage = this.storage.setIn([this.cursorRow, this.cursorColumn], char);
    }

    private ensureRowExists(rowNumber: number): void {
        if (!this.storage.get(rowNumber)) {
            this.storage = this.storage.set(rowNumber, List<Char>());
        }
    }

    private emitData() {
        this.emit("data");
    }
}
