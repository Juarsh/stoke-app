package store

import (
	"context"
	"time"
)

// GoalsRepo: users, profiles and targets (package goals). The read methods
// scan into the given fields.
type GoalsRepo interface {
	// TargetOn: the target in effect on day (ErrNoRows: none from on or before it).
	TargetOn(ctx context.Context, userID int64, day time.Time, eff *time.Time, kcal, proteinG, carbsG, fatG, waterML, steps *int, custom *bool) error
	// FirstTarget: the user's oldest target (ErrNoRows: none).
	FirstTarget(ctx context.Context, userID int64, eff *time.Time, kcal, proteinG, carbsG, fatG, waterML, steps *int, custom *bool) error
	WeightKG(ctx context.Context, userID int64, w *float64) error
	Diet(ctx context.Context, userID int64, diet *string) error
	StepsInBudget(ctx context.Context, userID int64, b *bool) error
	Me(ctx context.Context, userID int64, email, name, tz, diet *string, stepsInBudget *bool) error
	Profile(ctx context.Context, userID int64, birthYear *int, heightCM, weightKG *float64, activityLevel, goal *string, maintenanceKcal **int) error
	UpdateMe(ctx context.Context, userID int64, name, diet *string, stepsInBudget *bool) error
	DeleteUser(ctx context.Context, userID int64) error
	PutProfile(ctx context.Context, userID int64, birthYear int, heightCM, weightKG float64, activityLevel, goal string, maintenanceKcal int) error
	SetDiet(ctx context.Context, userID int64, diet string) error
	PutTarget(ctx context.Context, userID int64, day time.Time, kcal, proteinG, carbsG, fatG, waterML, steps int, custom bool) error
}

func (r repo) TargetOn(ctx context.Context, userID int64, day time.Time, eff *time.Time, kcal, proteinG, carbsG, fatG, waterML, steps *int, custom *bool) error {
	return r.q.QueryRow(ctx, `SELECT effective_from,kcal,protein_g,carbs_g,fat_g,water_ml,steps,custom FROM targets
		WHERE user_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC LIMIT 1`, userID, day).
		Scan(eff, kcal, proteinG, carbsG, fatG, waterML, steps, custom)
}

func (r repo) FirstTarget(ctx context.Context, userID int64, eff *time.Time, kcal, proteinG, carbsG, fatG, waterML, steps *int, custom *bool) error {
	return r.q.QueryRow(ctx, `SELECT effective_from,kcal,protein_g,carbs_g,fat_g,water_ml,steps,custom FROM targets
			WHERE user_id=$1 ORDER BY effective_from LIMIT 1`, userID).
		Scan(eff, kcal, proteinG, carbsG, fatG, waterML, steps, custom)
}

func (r repo) WeightKG(ctx context.Context, userID int64, w *float64) error {
	return r.q.QueryRow(ctx, `SELECT weight_kg FROM profiles WHERE user_id=$1`, userID).Scan(w)
}

func (r repo) Diet(ctx context.Context, userID int64, diet *string) error {
	return r.q.QueryRow(ctx, `SELECT diet FROM users WHERE id=$1`, userID).Scan(diet)
}

func (r repo) StepsInBudget(ctx context.Context, userID int64, b *bool) error {
	return r.q.QueryRow(ctx, `SELECT steps_in_budget FROM users WHERE id=$1`, userID).Scan(b)
}

func (r repo) Me(ctx context.Context, userID int64, email, name, tz, diet *string, stepsInBudget *bool) error {
	return r.q.QueryRow(ctx, `SELECT email,name,tz,diet,steps_in_budget FROM users WHERE id=$1`, userID).
		Scan(email, name, tz, diet, stepsInBudget)
}

func (r repo) Profile(ctx context.Context, userID int64, birthYear *int, heightCM, weightKG *float64, activityLevel, goal *string, maintenanceKcal **int) error {
	return r.q.QueryRow(ctx, `SELECT birth_year,height_cm,weight_kg,activity_level,goal,maintenance_kcal FROM profiles WHERE user_id=$1`, userID).
		Scan(birthYear, heightCM, weightKG, activityLevel, goal, maintenanceKcal)
}

func (r repo) UpdateMe(ctx context.Context, userID int64, name, diet *string, stepsInBudget *bool) error {
	_, err := r.q.Exec(ctx, `UPDATE users SET name=COALESCE($2,name), diet=COALESCE($3,diet), steps_in_budget=COALESCE($4,steps_in_budget) WHERE id=$1`,
		userID, name, diet, stepsInBudget)
	return err
}

func (r repo) DeleteUser(ctx context.Context, userID int64) error {
	_, err := r.q.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	return err
}

func (r repo) PutProfile(ctx context.Context, userID int64, birthYear int, heightCM, weightKG float64, activityLevel, goal string, maintenanceKcal int) error {
	_, err := r.q.Exec(ctx, `INSERT INTO profiles(user_id,birth_year,height_cm,weight_kg,activity_level,goal,maintenance_kcal) VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (user_id) DO UPDATE SET birth_year=$2,height_cm=$3,weight_kg=$4,activity_level=$5,goal=$6,maintenance_kcal=$7,updated_at=now()`,
		userID, birthYear, heightCM, weightKG, activityLevel, goal, maintenanceKcal)
	return err
}

func (r repo) SetDiet(ctx context.Context, userID int64, diet string) error {
	_, err := r.q.Exec(ctx, `UPDATE users SET diet=$2 WHERE id=$1`, userID, diet)
	return err
}

func (r repo) PutTarget(ctx context.Context, userID int64, day time.Time, kcal, proteinG, carbsG, fatG, waterML, steps int, custom bool) error {
	_, err := r.q.Exec(ctx, `INSERT INTO targets(user_id,effective_from,kcal,protein_g,carbs_g,fat_g,water_ml,steps,custom) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (user_id,effective_from) DO UPDATE SET kcal=$3,protein_g=$4,carbs_g=$5,fat_g=$6,water_ml=$7,steps=$8,custom=$9,updated_at=now()`,
		userID, day, kcal, proteinG, carbsG, fatG, waterML, steps, custom)
	return err
}
