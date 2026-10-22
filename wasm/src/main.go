// Command wasm exposes a small read-write JoyDB playground to the browser.
// It compiles the real JoyDB engine to WebAssembly and seeds it with the
// portfolio's own data at boot.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"
	"syscall/js"
	"time"
	"unicode/utf8"

	joydb "github.com/leengari/joydb"
)

//go:embed data/content.json
var contentFS embed.FS

type experience struct {
	ID        int64  `json:"id"`
	Company   string `json:"company"`
	Role      string `json:"role"`
	Period    string `json:"period"`
	StartDate string `json:"start_date"`
	Summary   string `json:"summary"`
	Impact    string `json:"impact"`
}

type project struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Language string `json:"language"`
	Stack    string `json:"stack"`
	Year     int64  `json:"year"`
	Headline string `json:"headline"`
	Detail   string `json:"detail"`
	Stat     string `json:"stat"`
	Link     string `json:"link"`
}

type metric struct {
	ID           int64  `json:"id"`
	ExperienceID int64  `json:"experience_id"`
	Label        string `json:"label"`
	Value        string `json:"value"`
	Context      string `json:"context"`
}

type stackRow struct {
	ID       int64  `json:"id"`
	Category string `json:"category"`
	Items    string `json:"items"`
}

type visitor struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Note      string `json:"note"`
	CreatedAt string `json:"created_at"`
}

type content struct {
	Experience []experience `json:"experience"`
	Projects   []project    `json:"projects"`
	Metrics    []metric     `json:"metrics"`
	Stack      []stackRow   `json:"stack"`
	Visitors   []visitor    `json:"visitors"`
}

type queryResponse struct {
	OK        bool            `json:"ok"`
	Columns   []string        `json:"columns,omitempty"`
	Rows      [][]interface{} `json:"rows,omitempty"`
	Count     int             `json:"count"`
	Truncated bool            `json:"truncated,omitempty"`
	Error     string          `json:"error,omitempty"`
	ElapsedMS float64         `json:"elapsedMs"`
}

type execResponse struct {
	OK           bool    `json:"ok"`
	Message      string  `json:"message,omitempty"`
	RowsAffected int64   `json:"rowsAffected"`
	LastInsertID int64   `json:"lastInsertId"`
	Error        string  `json:"error,omitempty"`
	ElapsedMS    float64 `json:"elapsedMs"`
}

type actionResponse struct {
	OK        bool    `json:"ok"`
	Message   string  `json:"message,omitempty"`
	ID        int64   `json:"id,omitempty"`
	Error     string  `json:"error,omitempty"`
	ElapsedMS float64 `json:"elapsedMs"`
}

const maxRows = 500

var (
	store          *joydb.Store
	db             *joydb.DB
	cachedContent  content
	queryFunc      js.Func
	execFunc       js.Func
	addVisitorFunc js.Func
	resetFunc      js.Func
)

func main() {
	started := time.Now()
	err := boot()

	api := map[string]interface{}{
		"ready":  err == nil,
		"bootMs": milliseconds(time.Since(started)),
	}
	if err != nil {
		api["initError"] = err.Error()
	} else {
		queryFunc = js.FuncOf(runQuery)
		execFunc = js.FuncOf(runExec)
		addVisitorFunc = js.FuncOf(runAddVisitor)
		resetFunc = js.FuncOf(runReset)
		api["query"] = queryFunc
		api["exec"] = execFunc
		api["addVisitor"] = addVisitorFunc
		api["reset"] = resetFunc
		api["engine"] = "JoyDB"
	}
	js.Global().Set("JoyDB", js.ValueOf(api))

	// Keep the Go runtime alive for the lifetime of the page.
	select {}
}

func boot() error {
	raw, err := contentFS.ReadFile("data/content.json")
	if err != nil {
		return fmt.Errorf("read seed content: %w", err)
	}
	if err := json.Unmarshal(raw, &cachedContent); err != nil {
		return fmt.Errorf("parse seed content: %w", err)
	}

	store, err = joydb.Open(":memory:")
	if err != nil {
		return fmt.Errorf("open in-memory store: %w", err)
	}
	db, err = store.DB("portfolio")
	if err != nil {
		return fmt.Errorf("open portfolio database: %w", err)
	}
	if err := createAndSeed(db); err != nil {
		return err
	}

	// Fail loudly at boot rather than in front of a visitor.
	rows, err := db.Query("SELECT COUNT(*) AS experiences FROM experience")
	if err != nil {
		return fmt.Errorf("sanity query: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return fmt.Errorf("sanity query returned no rows")
	}
	return nil
}

func createAndSeed(target *joydb.DB) error {
	for _, ddl := range schemaDDL {
		if _, err := target.Exec(ddl); err != nil {
			return fmt.Errorf("create schema: %w", err)
		}
	}
	return seedData(target, cachedContent)
}

var schemaDDL = []string{
	`CREATE TABLE experience (
		id INT PRIMARY KEY,
		company TEXT NOT NULL,
		role TEXT NOT NULL,
		period TEXT NOT NULL,
		start_date DATE NOT NULL,
		summary TEXT NOT NULL,
		impact TEXT NOT NULL
	)`,
	`CREATE TABLE projects (
		id INT PRIMARY KEY,
		name TEXT NOT NULL,
		language TEXT NOT NULL,
		stack TEXT NOT NULL,
		year INT NOT NULL,
		headline TEXT NOT NULL,
		detail TEXT NOT NULL,
		stat TEXT NOT NULL,
		link TEXT
	)`,
	`CREATE TABLE metrics (
		id INT PRIMARY KEY,
		experience_id INT NOT NULL,
		label TEXT NOT NULL,
		value TEXT NOT NULL,
		context TEXT NOT NULL,
		FOREIGN KEY (experience_id) REFERENCES experience(id)
	)`,
	`CREATE TABLE stack (
		id INT PRIMARY KEY,
		category TEXT NOT NULL,
		items TEXT NOT NULL
	)`,
	`CREATE TABLE visitors (
		id INT PRIMARY KEY,
		name TEXT NOT NULL,
		note TEXT,
		created_at TEXT NOT NULL
	)`,
}

func seedData(target *joydb.DB, seed content) error {
	for _, row := range seed.Experience {
		if _, err := target.Exec(
			`INSERT INTO experience (id, company, role, period, start_date, summary, impact)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			row.ID, row.Company, row.Role, row.Period, row.StartDate, row.Summary, row.Impact,
		); err != nil {
			return fmt.Errorf("seed experience %d: %w", row.ID, err)
		}
	}
	for _, row := range seed.Projects {
		if _, err := target.Exec(
			`INSERT INTO projects (id, name, language, stack, year, headline, detail, stat, link)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			row.ID, row.Name, row.Language, row.Stack, row.Year, row.Headline, row.Detail, row.Stat, nullIfEmpty(row.Link),
		); err != nil {
			return fmt.Errorf("seed project %d: %w", row.ID, err)
		}
	}
	for _, row := range seed.Metrics {
		if _, err := target.Exec(
			`INSERT INTO metrics (id, experience_id, label, value, context)
			 VALUES (?, ?, ?, ?, ?)`,
			row.ID, row.ExperienceID, row.Label, row.Value, row.Context,
		); err != nil {
			return fmt.Errorf("seed metric %d: %w", row.ID, err)
		}
	}
	for _, row := range seed.Stack {
		if _, err := target.Exec(
			`INSERT INTO stack (id, category, items) VALUES (?, ?, ?)`,
			row.ID, row.Category, row.Items,
		); err != nil {
			return fmt.Errorf("seed stack %d: %w", row.ID, err)
		}
	}
	for _, row := range seed.Visitors {
		if _, err := target.Exec(
			`INSERT INTO visitors (id, name, note, created_at) VALUES (?, ?, ?, ?)`,
			row.ID, row.Name, row.Note, row.CreatedAt,
		); err != nil {
			return fmt.Errorf("seed visitor %d: %w", row.ID, err)
		}
	}
	return nil
}

func runQuery(_ js.Value, args []js.Value) (out interface{}) {
	started := time.Now()
	response := queryResponse{}
	defer func() {
		if recovered := recover(); recovered != nil {
			response = queryResponse{Error: fmt.Sprintf("engine panic: %v", recovered)}
		}
		response.ElapsedMS = milliseconds(time.Since(started))
		out = encode(response)
	}()

	if db == nil {
		response.Error = "database is not ready"
		return nil
	}
	if len(args) == 0 {
		response.Error = "no SQL supplied"
		return nil
	}
	sql := strings.TrimSpace(args[0].String())
	if sql == "" {
		response.Error = "no SQL supplied"
		return nil
	}
	if !isReadOnly(sql) {
		response.Error = "query() accepts SELECT only"
		return nil
	}

	rows, err := db.Query(sql)
	if err != nil {
		response.Error = err.Error()
		return nil
	}
	defer rows.Close()

	columns := rows.Columns()
	result := make([][]interface{}, 0, 16)
	for rows.Next() {
		if len(result) >= maxRows {
			response.Truncated = true
			break
		}
		values := make([]interface{}, len(columns))
		targets := make([]interface{}, len(columns))
		for i := range values {
			targets[i] = &values[i]
		}
		if err := rows.Scan(targets...); err != nil {
			response.Error = err.Error()
			return nil
		}
		result = append(result, values)
	}

	response.OK = true
	response.Columns = columns
	response.Rows = result
	response.Count = len(result)
	return nil
}

func runExec(_ js.Value, args []js.Value) (out interface{}) {
	started := time.Now()
	response := execResponse{}
	defer func() {
		if recovered := recover(); recovered != nil {
			response = execResponse{Error: fmt.Sprintf("engine panic: %v", recovered)}
		}
		response.ElapsedMS = milliseconds(time.Since(started))
		out = encode(response)
	}()

	if db == nil {
		response.Error = "database is not ready"
		return nil
	}
	if len(args) == 0 {
		response.Error = "no SQL supplied"
		return nil
	}
	sql := strings.TrimSpace(args[0].String())
	if sql == "" {
		response.Error = "no SQL supplied"
		return nil
	}

	keyword := firstKeyword(sql)
	switch keyword {
	case "INSERT", "UPDATE", "DELETE":
	default:
		response.Error = "exec() accepts INSERT, UPDATE, or DELETE"
		return nil
	}

	result, err := db.Exec(sql)
	if err != nil {
		response.Error = err.Error()
		return nil
	}

	response.OK = true
	response.RowsAffected = result.RowsAffected()
	response.LastInsertID = result.LastInsertID()
	response.Message = fmt.Sprintf("%s %d", keyword, result.RowsAffected())
	return nil
}

func runAddVisitor(_ js.Value, args []js.Value) (out interface{}) {
	started := time.Now()
	response := actionResponse{}
	defer func() {
		if recovered := recover(); recovered != nil {
			response = actionResponse{Error: fmt.Sprintf("engine panic: %v", recovered)}
		}
		response.ElapsedMS = milliseconds(time.Since(started))
		out = encode(response)
	}()

	if db == nil {
		response.Error = "database is not ready"
		return nil
	}
	if len(args) == 0 {
		response.Error = "a name is required"
		return nil
	}

	name := strings.TrimSpace(args[0].String())
	note := ""
	if len(args) > 1 {
		note = strings.TrimSpace(args[1].String())
	}
	if name == "" {
		response.Error = "a name is required"
		return nil
	}
	if utf8.RuneCountInString(name) > 40 {
		response.Error = "keep the name under 40 characters"
		return nil
	}
	if utf8.RuneCountInString(note) > 80 {
		response.Error = "keep the note under 80 characters"
		return nil
	}

	id, err := nextVisitorID()
	if err != nil {
		response.Error = err.Error()
		return nil
	}
	created := time.Now().Format("2006-01-02")
	if _, err := db.Exec(
		`INSERT INTO visitors (id, name, note, created_at) VALUES (?, ?, ?, ?)`,
		id, name, note, created,
	); err != nil {
		response.Error = err.Error()
		return nil
	}

	response.OK = true
	response.ID = id
	response.Message = "visitor added"
	return nil
}

func runReset(_ js.Value, _ []js.Value) (out interface{}) {
	started := time.Now()
	response := actionResponse{}
	defer func() {
		if recovered := recover(); recovered != nil {
			response = actionResponse{Error: fmt.Sprintf("engine panic: %v", recovered)}
		}
		response.ElapsedMS = milliseconds(time.Since(started))
		out = encode(response)
	}()

	if store == nil {
		response.Error = "database is not ready"
		return nil
	}
	if err := store.DropDB("portfolio"); err != nil {
		response.Error = err.Error()
		return nil
	}
	fresh, err := store.DB("portfolio")
	if err != nil {
		response.Error = err.Error()
		return nil
	}
	db = fresh
	if err := createAndSeed(db); err != nil {
		response.Error = err.Error()
		return nil
	}

	response.OK = true
	response.Message = "database reset"
	return nil
}

func nextVisitorID() (int64, error) {
	rows, err := db.Query("SELECT MAX(id) AS max_id FROM visitors")
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	var maxID int64
	if rows.Next() {
		if err := rows.Scan(&maxID); err != nil {
			return 0, err
		}
	}
	return maxID + 1, nil
}

func isReadOnly(sql string) bool {
	return firstKeyword(sql) == "SELECT"
}

func firstKeyword(sql string) string {
	fields := strings.Fields(sql)
	if len(fields) == 0 {
		return ""
	}
	return strings.ToUpper(fields[0])
}

func nullIfEmpty(value string) interface{} {
	if value == "" {
		return nil
	}
	return value
}

func encode(value interface{}) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `{"ok":false,"error":"could not encode result"}`
	}
	return string(encoded)
}

func milliseconds(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000
}
