//go:build !linux

package collector

import "errors"

func NewSampler() (*Sampler, error) {
	return nil, errors.New("the Caudal collector requires Linux")
}
