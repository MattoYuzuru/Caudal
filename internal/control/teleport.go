package control

import (
	"errors"
	"net/http"

	"github.com/MattoYuzuru/Caudal/internal/teleport"
)

func (s *Server) teleportProfiles(w http.ResponseWriter, _ *http.Request) {
	profiles := []teleport.Profile{}
	if s.config.Teleport != nil {
		profiles = s.config.Teleport.List()
	}
	respond(w, http.StatusOK, struct {
		Profiles []teleport.Profile `json:"profiles"`
	}{profiles})
}

func (s *Server) checkTeleport(w http.ResponseWriter, r *http.Request) {
	if s.config.Teleport == nil {
		failure(w, http.StatusNotFound, "teleport_profile_not_found")
		return
	}
	profile, err := s.config.Teleport.Check(r.Context(), r.PathValue("id"))
	if errors.Is(err, teleport.ErrUnknown) {
		failure(w, http.StatusNotFound, "teleport_profile_not_found")
		return
	}
	if err != nil {
		failure(w, http.StatusTooManyRequests, "teleport_check_busy")
		return
	}
	respond(w, http.StatusOK, struct {
		Profile teleport.Profile `json:"profile"`
	}{profile})
}
